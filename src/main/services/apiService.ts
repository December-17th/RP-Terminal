import { Settings } from '../types/models';

export const completeChat = async (settings: Settings, messages: any[]): Promise<string> => {
  const { provider } = settings.api;
  
  if (provider === 'anthropic') {
    return completeAnthropic(settings, messages);
  } else {
    return completeOpenAICompatible(settings, messages);
  }
};

const completeOpenAICompatible = async (settings: Settings, messages: any[]): Promise<string> => {
  const { endpoint, api_key, model, default_params } = settings.api;
  
  const url = endpoint.endsWith('/chat/completions') ? endpoint : `${endpoint.replace(/\/$/, '')}/chat/completions`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${api_key}`
    },
    body: JSON.stringify({
      model,
      messages,
      ...default_params,
      stream: false
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API Error: ${response.status} ${response.statusText} - ${errorText}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
};

const completeAnthropic = async (settings: Settings, messages: any[]): Promise<string> => {
  const { endpoint, api_key, model, default_params } = settings.api;
  // Fallback to default anthropic endpoint if empty
  const baseUrl = endpoint || 'https://api.anthropic.com/v1';
  const url = baseUrl.endsWith('/messages') ? baseUrl : `${baseUrl.replace(/\/$/, '')}/messages`;
  
  // Extract system prompt since Anthropic uses a top-level system parameter
  let systemPrompt = '';
  const anthropicMessages = messages.filter(m => {
    if (m.role === 'system') {
      systemPrompt += m.content + '\n';
      return false;
    }
    return true;
  });

  // Combine consecutive messages of the same role if any (Anthropic requires alternating roles)
  const mergedMessages: any[] = [];
  for (const msg of anthropicMessages) {
    if (mergedMessages.length > 0 && mergedMessages[mergedMessages.length - 1].role === msg.role) {
      mergedMessages[mergedMessages.length - 1].content += '\n\n' + msg.content;
    } else {
      mergedMessages.push({ ...msg });
    }
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': api_key,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: model || 'claude-3-5-sonnet-20240620',
      system: systemPrompt.trim() || undefined,
      messages: mergedMessages,
      max_tokens: default_params.max_tokens || 4000,
      temperature: default_params.temperature || 0.9,
      stream: false
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Anthropic API Error: ${response.status} ${response.statusText} - ${errorText}`);
  }

  const data = await response.json();
  return data.content[0].text;
};
