import axios from 'axios';
import * as cheerio from 'cheerio';

/**
 * Extract full text content from a URL
 * Handles Twitter, articles, blogs, etc.
 */
export async function extractContentFromUrl(url: string): Promise<string> {
  try {
    // For Twitter/X posts, extract from the URL pattern
    if (url.includes('twitter.com') || url.includes('x.com')) {
      return await extractTwitterContent(url);
    }
    
    // For general web pages
    return await extractWebPageContent(url);
  } catch (error) {
    console.error('Content extraction failed:', error);
    return ''; // Return empty if extraction fails
  }
}

/**
 * Extract content from Twitter/X posts
 */
async function extractTwitterContent(url: string): Promise<string> {
  try {
    const response = await axios.get(url, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      },
    });
    
    const $ = cheerio.load(response.data);
    
    // Try to extract tweet text from meta tags
    const tweetText = 
      $('meta[property="og:description"]').attr('content') ||
      $('meta[name="description"]').attr('content') ||
      $('article [data-testid="tweetText"]').text() ||
      '';
    
    return tweetText.trim();
  } catch (error) {
    console.log('Twitter extraction failed, returning empty');
    return '';
  }
}

/**
 * Extract content from general web pages
 */
async function extractWebPageContent(url: string): Promise<string> {
  try {
    const response = await axios.get(url, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
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
