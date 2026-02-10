import axios, { type AxiosError } from 'axios';
import * as cheerio from 'cheerio';

/**
 * SSRF & Security Protection
 */

// Block private/internal IP ranges to prevent SSRF attacks
const BLOCKED_IP_PATTERNS = [
  /^127\./,           // Localhost
  /^10\./,            // Private network
  /^172\.(1[6-9]|2\d|3[01])\./,  // Private network
  /^192\.168\./,      // Private network
  /^169\.254\./,      // Link-local
  /^::1$/,            // IPv6 localhost
  /^fe80:/,           // IPv6 link-local
  /^fc00:|^fd00:/,    // IPv6 private
];

// Optional: Whitelist of allowed domains (leave empty to allow all public domains)
const ALLOWED_DOMAINS = process.env.ALLOWED_CONTENT_DOMAINS?.split(',').map(d => d.trim().toLowerCase()) || [];

// Rate limiting: track requests per user
const userRequestCounts = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT_REQUESTS = 10;
const RATE_LIMIT_WINDOW = 60000; // 1 minute

/**
 * Validate URL for SSRF protection
 */
function validateUrl(url: string): void {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase();
    
    // Check if hostname is an IP address and if it's blocked
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(hostname) || /^[\da-f:]+$/.test(hostname)) {
      for (const pattern of BLOCKED_IP_PATTERNS) {
        if (pattern.test(hostname)) {
          throw new Error(`⛔ Access to private IP address blocked: ${hostname}`);
        }
      }
    }
    
    // Check domain whitelist if configured
    if (ALLOWED_DOMAINS.length > 0) {
      const isAllowed = ALLOWED_DOMAINS.some(domain => hostname === domain || hostname.endsWith('.' + domain));
      if (!isAllowed) {
        throw new Error(`⛔ Domain not in whitelist: ${hostname}`);
      }
    }
    
    // Check for suspicious protocols
    if (!['http:', 'https:'].includes(urlObj.protocol)) {
      throw new Error(`⛔ Only HTTP(S) protocols are allowed, got: ${urlObj.protocol}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('⛔')) {
      throw error;
    }
    throw new Error(`Invalid URL format: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Rate limit check per user
 */
function checkRateLimit(userId: string): void {
  const now = Date.now();
  const userLimits = userRequestCounts.get(userId);
  
  if (userLimits && userLimits.resetTime > now) {
    if (userLimits.count >= RATE_LIMIT_REQUESTS) {
      throw new Error(`⏱️  Rate limit exceeded. Max ${RATE_LIMIT_REQUESTS} requests per minute.`);
    }
    userLimits.count++;
  } else {
    userRequestCounts.set(userId, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
  }
}

/**
 * Retry logic with exponential backoff
 */
async function fetchWithRetry(
  url: string,
  options: any = {},
  maxRetries: number = 3,
  baseDelay: number = 1000
): Promise<any> {
  let lastError: AxiosError | null = null;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await axios.get(url, options);
    } catch (error) {
      lastError = error as AxiosError;
      
      // Don't retry on client errors (4xx) except 429 (rate limit)
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        if (status && status >= 400 && status < 500 && status !== 429) {
          throw error;
        }
      }
      
      // If it's the last attempt, throw the error
      if (attempt === maxRetries - 1) {
        throw error;
      }
      
      // Calculate exponential backoff delay
      const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 100;
      console.log(`⏳ Retry attempt ${attempt + 1}/${maxRetries} after ${Math.round(delay)}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  throw lastError || new Error('Max retries reached');
}

/**
 * Initialize Twitter API v2 client if credentials are available
 */
function getTwitterApiClient() {
  const bearerToken = process.env.TWITTER_BEARER_TOKEN;
  
  if (!bearerToken) {
    return null;
  }
  
  return {
    bearerToken,
    async getTweet(tweetId: string) {
      try {
        const response = await axios.get(
          `https://api.twitter.com/2/tweets/${tweetId}?tweet.fields=created_at,author_id&expansions=author_id&user.fields=username,verified`,
          {
            headers: {
              Authorization: `Bearer ${bearerToken}`,
            },
            timeout: 5000,
          }
        );
        
        return response.data.data?.text || null;
      } catch (error) {
        console.error('Twitter API error:', error instanceof Error ? error.message : 'Unknown error');
        return null;
      }
    },
  };
}

/**
 * Extract tweet ID from Twitter/X URL
 */
function extractTweetId(url: string): string | null {
  const match = url.match(/(?:twitter\.com|x\.com)\/\w+\/status\/(\d+)/);
  return match?.[1] ?? null;
}

/**
 * Extract full text content from a URL
 * Handles Twitter, articles, blogs, etc.
 * 
 * SECURITY FEATURES:
 * - SSRF protection: Blocks private IP ranges and internal networks
 * - Domain whitelisting: Optional whitelist via ALLOWED_CONTENT_DOMAINS env var
 * - Rate limiting: Max 10 requests per minute per user
 * - Retry logic: Exponential backoff for transient failures
 * - Protocol validation: Only HTTP(S) allowed
 */
export async function extractContentFromUrl(url: string, userId?: string): Promise<string> {
  try {
    // Validate URL for SSRF protection
    validateUrl(url);
    
    // Check rate limit if userId provided
    if (userId) {
      checkRateLimit(userId);
    }
    
    // For Twitter/X posts, extract from the URL pattern
    if (url.includes('twitter.com') || url.includes('x.com')) {
      return await extractTwitterContent(url);
    }
    
    // For general web pages
    return await extractWebPageContent(url);
  } catch (error) {
    if (error instanceof Error && (error.message.startsWith('⛔') || error.message.startsWith('⏱️'))) {
      console.warn(`Security check failed: ${error.message}`);
      throw error; // Re-throw security errors
    }
    console.error('Content extraction failed:', error);
    return ''; // Return empty if extraction fails
  }
}

/**
 * Extract content from Twitter/X posts
 * 
 * STRATEGY: Attempts multiple extraction methods in order of reliability:
 * 1. Twitter API v2 (if TWITTER_BEARER_TOKEN is set): Most reliable
 * 2. Static HTML meta tags: Fallback for public tweets
 * 3. Cheerio parsing: Last resort (unlikely to work on modern Twitter/X)
 * 
 * SETUP FOR TWITTER API:
 * 1. Create a Twitter Developer account at developer.twitter.com
 * 2. Create an app and get your Bearer Token
 * 3. Set TWITTER_BEARER_TOKEN environment variable
 * 
 * Without API credentials, extraction will fall back to static parsing
 * which has limited success on modern JavaScript-heavy Twitter/X.
 */
async function extractTwitterContent(url: string): Promise<string> {
  try {
    // Try Twitter API first if credentials available
    const tweetId = extractTweetId(url);
    if (tweetId) {
      const apiClient = getTwitterApiClient();
      if (apiClient) {
        console.log('🐦 Attempting extraction via Twitter API v2...');
        const tweetText = await apiClient.getTweet(tweetId);
        if (tweetText) {
          console.log('✅ Tweet extracted via API');
          return tweetText;
        }
        console.log('⚠️  Twitter API returned empty, trying fallback methods');
      } else {
        console.log('💡 Tip: Set TWITTER_BEARER_TOKEN to enable official Twitter API extraction');
      }
    }
    
    // Fallback: Try static HTML extraction with retry logic
    const response = await fetchWithRetry(url, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
      },
    });
    
    const $ = cheerio.load(response.data);
    
    // Try to extract tweet text from meta tags (may be empty due to dynamic loading)
    const tweetText = 
      $('meta[property="og:description"]').attr('content') ||
      $('meta[name="description"]').attr('content') ||
      $('article [data-testid="tweetText"]').text() ||
      '';
    
    if (!tweetText) {
      console.warn('⚠️  Twitter/X extraction returned empty - consider setting TWITTER_BEARER_TOKEN for reliable extraction');
    }
    
    return tweetText.trim();
  } catch (error) {
    console.error('Twitter extraction failed:', error instanceof Error ? error.message : 'Unknown error');
    return '';
  }
}

/**
 * Extract content from general web pages
 * Uses retry logic for transient failures
 */
async function extractWebPageContent(url: string): Promise<string> {
  try {
    const response = await fetchWithRetry(url, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
      },
      maxRedirects: 5,
    });
    
    const $ = cheerio.load(response.data);
    
    // Remove unwanted elements
    $('script, style, nav, footer, header, aside, iframe, noscript').remove();
    
    // Try to find main content
    let content = 
      $('article').text() ||
      $('main').text() ||
      $('.post-content').text() ||
      $('.article-content').text() ||
      $('.content').text() ||
      $('body').text();
    
    // Clean up whitespace
    content = content
      .replace(/\s+/g, ' ')
      .replace(/\n+/g, '\n')
      .trim();
    
    // Limit to 15000 characters (enough for good context)
    return content.substring(0, 15000);
  } catch (error) {
    console.log('Web page extraction failed:', error instanceof Error ? error.message : 'Unknown error');
    return '';
  }
}

/**
 * Create a rich text representation combining title and content
 */
export function createRichContent(title: string, link: string, extractedContent: string): string {
  if (!extractedContent || extractedContent.length < 50) {
    // If extraction failed or content too short, use title only
    return `Title: ${title}\nLink: ${link}`;
  }
  
  return `Title: ${title}\nLink: ${link}\n\nContent:\n${extractedContent}`;
}
