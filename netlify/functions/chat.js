// netlify/functions/chat.js
// Fast ADHD-friendly impulse spending companion

const fetch = globalThis.fetch;

// Prioritize fastest, most reliable services
const AI_SERVICES = [
  {
    name: 'Groq',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    headers: {
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    model: 'llama3-8b-8192',
    timeout: 5000 // Much shorter timeout
  }
  // Removed Hugging Face - it's too slow and unreliable
];

const SYSTEM_PROMPT = `You ONLY help with impulse spending decisions using these 4 questions IN ORDER:

1. "Do I need this, or do I just want it?"
2. "Where will I store this?"  
3. "Can I wait 24 hours before buying this?"
4. "How will I feel about this purchase tomorrow?"

RULES:
- Ask ONE question at a time
- Wait for their answer before moving to next question
- Keep responses SHORT (1 sentence max) - ADHD brains get overwhelmed
- Talk casual like texting a friend
- ONLY discuss these 4 questions - nothing else
- If they try to talk about other stuff, gently bring them back to the current question

Start with question 1, then move through them in order. That's it.`;

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

    const finalSystemPrompt = systemPrompt || SYSTEM_PROMPT;

    // Build conversation - keep it shorter for speed
    const messages = [
      { role: 'system', content: finalSystemPrompt },
      ...history.slice(-6), // Only last 6 messages for speed
      { role: 'user', content: message }
    ];

    // Try AI service with much shorter timeout
    if (AI_SERVICES.length > 0 && process.env.GROQ_API_KEY) {
      try {
        const response = await callAIService(AI_SERVICES[0], messages);
        
        if (response && response.trim()) {
          return {
            statusCode: 200,
            headers: {
              'Access-Control-Allow-Origin': '*',
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              response: response.trim(),
              service: 'Groq'
            })
          };
        }
      } catch (error) {
        console.log(`Groq failed, using fallback:`, error.message);
        // Fall through to local fallback
      }
    }

    // Smart local fallback that feels more human
    const fallbackResponse = getSmartFallback(message, history);
    
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        response: fallbackResponse,
        service: 'Local Buddy'
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
        response: "ugh my brain's glitching rn but I'm still here! what were you thinking of buying?",
        service: 'Offline'
      })
    };
  }
};

async function callAIService(service, messages) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), service.timeout);

  try {
    const requestBody = {
      model: service.model,
      messages: messages,
      max_tokens: 80, // Shorter responses for speed
      temperature: 0.9, // More personality
      stream: false
    };

    const response = await fetch(service.url, {
      method: 'POST',
      headers: service.headers,
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

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
    clearTimeout(timeoutId);
    throw error;
  }
}

function getSmartFallback(message, history) {
  // The 4 EXACT questions from the PDF
  const questions = [
    "Do I need this, or do I just want it?",
    "Where will I store this?", 
    "Can I wait 24 hours before buying this?",
    "How will I feel about this purchase tomorrow?"
  ];
  
  // Determine which question to ask based on conversation flow
  let questionIndex = 0;
  
  // Look at history to see where we are in the process
  const historyText = history.map(h => h.text || '').join(' ').toLowerCase();
  
  if (historyText.includes('need') || historyText.includes('want')) {
    questionIndex = 1; // Move to storage question
  } else if (historyText.includes('store') || historyText.includes('put') || historyText.includes('space')) {
    questionIndex = 2; // Move to 24 hour question  
  } else if (historyText.includes('wait') || historyText.includes('24') || historyText.includes('hour')) {
    questionIndex = 3; // Move to tomorrow question
  }
  
  // Make sure we don't go past the last question
  questionIndex = Math.min(questionIndex, questions.length - 1);
  
  return questions[questionIndex];
}
