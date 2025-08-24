// netlify/functions/chat.js
// Serverless function to connect to multiple free AI APIs

const fetch = require('node-fetch');

// Multiple free AI services as fallbacks
const AI_SERVICES = [
  {
    name: 'Groq',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    headers: {
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    model: 'llama3-70b-8192'
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

const SYSTEM_PROMPT = `You are an ADHD-friendly AI companion specifically designed to help with impulse spending decisions. Your personality:

- Warm, empathetic friend (never robotic or clinical)
- Remember our conversation context
- When someone mentions buying something, naturally guide them through these key questions:
  1. Do you need this, or do you just want it?
  2. Where will you store this?
  3. Can you wait 24 hours before buying this?
  4. How will you feel about this purchase tomorrow?

CRITICAL RULES:
- Keep responses SHORT (1-3 sentences max) - ADHD brains get overwhelmed
- Don't list numbered questions - weave them naturally into conversation
- Validate their feelings first before discussing purchases
- Talk like texting a close friend, not giving therapy
- Be supportive whether they decide to buy or not buy
- Remember details they share and reference them naturally later

Respond as if you're talking out loud in a voice conversation.`;

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
        console.log(`Trying ${service.name}...`);
        const response = await callAIService(service, messages);
        
        if (response && response.trim()) {
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
        }
      } catch (error) {
        console.log(`${service.name} failed:`, error.message);
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
  const lower = message.toLowerCase();
  
  // Check for purchase-related keywords
  const purchaseWords = ['buy', 'buying', 'purchase', 'order', 'sale', 'discount', 'deal', 'shopping', 'cart', 'checkout'];
  const isPurchase = purchaseWords.some(word => lower.includes(word));
  
  // Check emotional state
  const stressWords = ['stressed', 'anxious', 'overwhelmed', 'tired', 'impulse', 'urge'];
  const isStressed = stressWords.some(word => lower.includes(word));
  
  if (isPurchase) {
    const purchaseResponses = [
      "I hear you thinking about this purchase. What's drawing you to it right now?",
      "Let's pause together. Do you actually need this, or is it more of a want?",
      "Before we decide - where would you put this once you get it home?",
      "Take a breath with me. How do you think you'll feel about this purchase tomorrow?"
    ];
    return purchaseResponses[Math.floor(Math.random() * purchaseResponses.length)];
  }
  
  if (isStressed) {
    return "I can hear some stress in your voice. Let's take a breath first. What's really going on?";
  }
  
  if (lower.includes('hello') || lower.includes('hi') || lower.includes('hey')) {
    return "Hey! Nice to hear your voice. What's on your mind today?";
  }

  if (lower.includes('help') || lower.includes('support')) {
    return "I'm here for you. Tell me what's happening and we'll figure it out together.";
  }
  
  const casualResponses = [
    "I'm listening. Tell me more about that.",
    "That sounds important to you. What's behind that feeling?",
    "I hear you. How are you processing that right now?",
    "Thanks for sharing that with me. What feels most important about this?"
  ];
  
  return casualResponses[Math.floor(Math.random() * casualResponses.length)];
}
