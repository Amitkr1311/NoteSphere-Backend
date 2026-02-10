#!/usr/bin/env node

/**
 * Test script to verify Ollama + Pinecone integration
 * Run: node test-integration.js
 */

import dotenv from 'dotenv';
dotenv.config();

import axios from 'axios';

const OLLAMA_API = process.env.OLLAMA_API || 'http://localhost:11434';

console.log('🧪 Testing Ollama + Pinecone Integration\n');

// Test 1: Check Ollama is running
async function testOllama() {
  try {
    console.log('1️⃣ Testing Ollama connection...');
    const response = await axios.get(`${OLLAMA_API}/api/tags`);
    const models = response.data.models || [];
    
    if (models.length === 0) {
      console.log('   ⚠️  Ollama running but no models found');
      console.log('   Run: ollama pull mistral');
      return false;
    }
    
    const hasMistral = models.some((m) => m.name.includes('mistral'));
    if (hasMistral) {
      console.log('   ✅ Ollama is running with Mistral model');
      return true;
    } else {
      console.log(`   ⚠️  Ollama running but Mistral not found`);
      console.log('   Available models:', models.map(m => m.name).join(', '));
      console.log('   Run: ollama pull mistral');
      return false;
    }
  } catch (error) {
    console.log('   ❌ Ollama not responding');
    console.log('   Make sure Ollama is installed and running');
    console.log('   Download from: https://ollama.com/download');
    return false;
  }
}

// Test 2: Test Ollama generation
async function testGeneration() {
  try {
    console.log('\n2️⃣ Testing Ollama text generation...');
    const response = await axios.post(`${OLLAMA_API}/api/generate`, {
      model: 'mistral',
      prompt: 'Say "Integration test successful!" and nothing else.',
      stream: false,
    });
    
    console.log('   ✅ Response:', response.data.response.substring(0, 100));
    return true;
  } catch (error) {
    console.log('   ❌ Generation failed:', error.message);
    return false;
  }
}

// Test 3: Check Pinecone environment variables
async function testPineconeConfig() {
  console.log('\n3️⃣ Checking Pinecone configuration...');
  
  const apiKey = process.env.PINECONE_API_KEY;
  const indexName = process.env.PINECONE_INDEX_NAME;
  
  if (!apiKey || apiKey === 'your_pinecone_api_key_here') {
    console.log('   ❌ PINECONE_API_KEY not set or using placeholder');
    console.log('   Get your key from: https://app.pinecone.io/');
    console.log('   Update .env file with: PINECONE_API_KEY=your_actual_key');
    return false;
  }
  
  if (!indexName) {
    console.log('   ❌ PINECONE_INDEX_NAME not set');
    return false;
  }
  
  console.log('   ✅ Pinecone API key is set');
  console.log('   ✅ Index name:', indexName);
  return true;
}

// Run all tests
async function runTests() {
  const ollamaOk = await testOllama();
  const generationOk = ollamaOk ? await testGeneration() : false;
  const pineconeOk = await testPineconeConfig();
  
  console.log('\n📊 Test Summary:');
  console.log('   Ollama:', ollamaOk ? '✅' : '❌');
  console.log('   Generation:', generationOk ? '✅' : '❌');
  console.log('   Pinecone Config:', pineconeOk ? '✅' : '❌');
  
  if (ollamaOk && generationOk && pineconeOk) {
    console.log('\n🎉 All checks passed! Your RAG system is ready.');
    console.log('   Start the server: npm run dev');
  } else {
    console.log('\n⚠️  Some checks failed. Please fix the issues above.');
  }
}

runTests();
