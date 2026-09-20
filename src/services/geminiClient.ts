import { Config } from '../config/env.js';

export interface GeminiResult {
  text: string;
  model: string;
  durationMs: number;
}

export async function generateJson(prompt: string, context: unknown, config: Config): Promise<GeminiResult> {
  if (!config.geminiApiKey) throw new Error('GEMINI_API_KEY is required for Gemini AI analysis');
  const model = config.geminiModel;
  const started = Date.now();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(config.geminiApiKey)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: `${prompt}\n\nInput:\n${JSON.stringify(context)}` }] }],
      generationConfig: { temperature: 0.1, responseMimeType: 'application/json' }
    })
  });
  if (!response.ok) throw new Error(`Gemini request failed: ${response.status} ${await response.text()}`);
  const payload = await response.json() as any;
  const text = String(payload.candidates?.[0]?.content?.parts?.map((part: any) => part.text || '').join('') || '');
  if (!text) throw new Error('Gemini returned an empty response');
  return { text, model, durationMs: Date.now() - started };
}
