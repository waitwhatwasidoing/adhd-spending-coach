// netlify/functions/chat.js
// Serverless function to connect to multiple free AI APIs

// Use built-in fetch (Node 18+) instead of node-fetch
const fetch = globalThis.fetch;

// Multiple free AI services as fallbacks
const AI_SERVICES = [
  {
    name: 'Groq',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    headers: {
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    model: 'llama3-8b-8192'
  },
  {
    name: 'Hugging Face',
    url: 'https://api-inference.huggingface.co/models/microsoft/DialoGPT-large',
    headers: {
      'Authorization': `Bearer ${process.env.HUGGINGFACE_API_KEY}`,
      'Content-Type': 'application/json'
    },
    model: 'microsoft/DialoGPT-large'
  }
];

const SYSTEM_PROMPT = `You are a close friend helping someone with ADHD who's considering an impulse purchase. You're having a casual voice conversation.

Your goal: Help them pause and think through these 4 questions naturally:
1. Do you need this, or do you just want it?
2. Where will you store this?
3. Can you wait 24 hours before buying this?
4. How will you feel about this purchase tomorrow?

HOW TO RESPOND:
- Talk like you're texting a best friend - casual, warm, understanding
- Keep it SHORT (1-2 sentences max) - ADHD brains get overwhelmed
- Never sound like a therapist or life coach
- Don't lecture or be preachy
- Validate their feelings first
- Weave the questions naturally into conversation
- Use "I" statements: "I'm curious..." "I wonder..."
- Be supportive of whatever they decide

Examples of good responses:
- "Ooh, what caught your eye about it?"
- "That sounds exciting! Where would you put it though?"
- "I get the appeal. Do you think you'd still want it tomorrow?"
- "Makes sense you're drawn to it. Need it or just really want it?"

Talk like a real person having a natural conversation.`;

exports.handler = async (event, context) => {
  // Handle CORS
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      }
    };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    const { message, history = [], systemPrompt } = JSON.parse(event.body);

    if (!message) {
      return {
        statusCode: 400,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ error: 'Message is required' })
      };
    }

    // Use custom system prompt if provided, otherwise use default
    const finalSystemPrompt = systemPrompt || SYSTEM_PROMPT;

    // Build conversation messages
    const messages = [
      { role: 'system', content: finalSystemPrompt },
      ...history.slice(-10), // Keep last 10 messages for context
      { role: 'user', content: message }
    ];

    // Try each AI service until one works
    for (const service of AI_SERVICES) {
      try {
        console.log(`Trying ${service.name}... API Key present: ${!!process.env[service.name === 'Groq' ? 'GROQ_API_KEY' : 'HUGGINGFACE_API_KEY']}`);
        const response = await callAIService(service, messages);
        
        if (response && response.trim()) {
          console.log(`${service.name} succeeded with response:`, response.substring(0, 50));
          return {
            statusCode: 200,
            headers: {
              'Access-Control-Allow-Origin': '*',
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              response: response.trim(),
              service: service.name
            })
          };
        } else {
          console.log(`${service.name} returned empty response`);
        }
      } catch (error) {
        console.log(`${service.name} failed with error:`, error.message);
        continue; // Try next service
      }
    }

    // If all AI services fail, use local fallback
    const fallbackResponse = getLocalFallback(message, history);
    
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        response: fallbackResponse,
        service: 'Local Coach'
      })
    };

  } catch (error) {
    console.error('Function error:', error);
    
    return {
      statusCode: 500,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        response: "I'm having trouble connecting right now, but I'm still here to help you think through this decision.",
        service: 'Offline'
      })
    };
  }
};

async function callAIService(service, messages) {
  try {
    // Special handling for Hugging Face (different format)
    if (service.name === 'Hugging Face') {
      const lastMessage = messages[messages.length - 1].content;
      const conversationContext = messages.slice(-3).map(m => m.content).join(' ');
      
      const response = await fetch(service.url, {
        method: 'POST',
        headers: service.headers,
        body: JSON.stringify({
          inputs: conversationContext,
          parameters: {
            max_new_tokens: 100,
            temperature: 0.8,
            do_sample: true,
            return_full_text: false
          }
        }),
        timeout: 10000 // 10 second timeout
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const data = await response.json();
      
      // Handle different response formats
      if (Array.isArray(data) && data.length > 0) {
        return data[0].generated_text || data[0].text;
      } else if (data.generated_text) {
        return data.generated_text;
      } else if (typeof data === 'string') {
        return data;
      }
      
      throw new Error('No valid response from Hugging Face');
    }

    // Standard OpenAI-compatible format (Groq)
    const requestBody = {
      model: service.model,
      messages: messages,
      max_tokens: 150,
      temperature: 0.8,
      stream: false
    };

    const response = await fetch(service.url, {
      method: 'POST',
      headers: service.headers,
      body: JSON.stringify(requestBody),
      timeout: 15000 // 15 second timeout
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    
    if (data.choices && data.choices.length > 0 && data.choices[0].message) {
      return data.choices[0].message.content;
    }
    
    throw new Error('No valid response from API');

  } catch (error) {
    console.error(`Error calling ${service.name}:`, error.message);
    throw error;
  }
}

function getLocalFallback(message, history) {
  // ONLY focus on the 4 core impulse pause questions - NO generic responses
  const coreQuestions = [
    "Do you need this, or do you just want it?",
    "Where will you store this?",
    "Can you wait 24 hours before buying this?", 
    "How will you feel about this purchase tomorrow?"
  ];
  
  // Determine which question to ask based on conversation
  let questionIndex = 0;
  if (history.length > 0) {
    questionIndex = Math.min(history.length, 3);
  }
  
  // Just ask the appropriate core question directly
  return coreQuestions[questionIndex];
}
