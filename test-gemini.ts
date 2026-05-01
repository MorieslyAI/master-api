import { GoogleGenAI, Modality } from "@google/genai";
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env' });

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
async function test() {
  const session = await ai.live.connect({
    model: "gemini-2.5-flash-native-audio-latest",
    config: {
      systemInstruction: { parts: [{ text: "Hello" }] },
      responseModalities: [Modality.AUDIO],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } },
      },
    },
    callbacks: {
      onopen: () => console.log("Open SUCCESS"),
      onmessage: () => {},
      onclose: (e) => console.log("Close", e.reason),
    }
  });
  await new Promise(r => setTimeout(r, 2000));
}
test();
