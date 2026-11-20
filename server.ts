/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import express from "express";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";

function createAiClient(apiKey: string) {
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

class BoundedMap<K, V> extends Map<K, V> {
  maxEntries: number;
  constructor(maxEntries: number) {
    super();
    this.maxEntries = maxEntries;
  }
  set(key: K, value: V): this {
    if (this.has(key)) {
      this.delete(key);
    } else if (this.size >= this.maxEntries) {
      const oldest = this.keys().next().value;
      if (oldest !== undefined) this.delete(oldest);
    }
    return super.set(key, value);
  }
}


function stripHttpOptions(val: any): any {
  if (!val || typeof val !== "object") return val;
  if (Array.isArray(val)) return val.map(stripHttpOptions);
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(val)) {
    if (
      k === "httpOptions" ||
      k === "http_options" ||
      k === "__proto__" ||
      k === "constructor" ||
      k === "prototype" ||
      k === "cachedContent" ||
      k === "cached_content" ||
      k === "fileSearch" ||
      k === "file_search" ||
      k === "corpora" ||
      k === "semanticRetriever" ||
      k === "semantic_retriever"
    ) continue;
    if ((k === "fileData" || k === "file_data") && v && typeof v === "object") {
      const rawU = (v as any).fileUri ?? (v as any).file_uri;
      const u = typeof rawU === "string" ? rawU.trim() : "";
      if (!/^https:\/\/(?:www\.|m\.)?(?:youtube\.com|youtu\.be)\//i.test(u)) continue;
    }
    out[k] = stripHttpOptions(v);
  }
  return out;
}


const MODEL_UPGRADES: Record<string, string> = {
  "gemini-2.5-flash": "gemini-3-flash-preview",
  "gemini-2.5-pro": "gemini-3.1-pro-preview",
  "gemini-3-pro-preview": "gemini-3.1-pro-preview",
  "gemini-2.0-flash": "gemini-3-flash-preview",
  "gemini-2.0-flash-exp": "gemini-3-flash-preview",
};

const ALLOWED_MODEL_RE = /^(?!.*\.\.)(?:models\/)?(?:gemini-|imagen-|veo-|lyria-|learnlm-|text-embedding-|gemini-embedding-)[a-zA-Z0-9._-]+$/;

function resolveModel(model?: string): string {
  const candidate = !model ? "gemini-3-flash-preview" : MODEL_UPGRADES[model] || model;
  if (!ALLOWED_MODEL_RE.test(candidate)) {
    throw new Error(`Disallowed model: ${candidate}`);
  }
  return candidate;
}

function serializeGenerateContentResponse(r: any) {
  return {
    candidates: r?.candidates,
    promptFeedback: r?.promptFeedback,
    usageMetadata: r?.usageMetadata,
    modelVersion: r?.modelVersion,
    responseId: r?.responseId,
    text: r?.text,
    functionCalls: r?.functionCalls,
    data: r?.data,
    executableCode: r?.executableCode,
    codeExecutionResult: r?.codeExecutionResult,
  };
}

const chats = new BoundedMap<string, any>(200);
const videoOps = new BoundedMap<string, { op: any; ownerKey: string }>(100);

function getClientKey(req: any): string {
  const raw = req?.headers?.["x-client-id"];
  if (typeof raw === "string" && /^[a-zA-Z0-9_-]{8,128}$/.test(raw.trim())) {
    return `cid:${raw.trim()}`;
  }
  const xffParts = String(req?.headers?.["x-forwarded-for"] || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const xff = xffParts.length >= 2 ? xffParts[xffParts.length - 2] : (xffParts[0] || "");
  return `ip:${xff || req?.ip || req?.socket?.remoteAddress || "unknown"}`;
}

async function startServer() {
  const app = express();
  app.set("trust proxy", 2);
  const PORT = Number(process.env.PORT) || 3000;

  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  app.use((req, _res, next) => {
    if (req.body && typeof req.body === "object") {
      req.body = stripHttpOptions(req.body);
    }
    next();
  });

  for (const dir of ["examples", "assets", "public"]) {
    const dirPath = path.join(process.cwd(), dir);
    if (fs.existsSync(dirPath)) {
      app.use(`/${dir}`, express.static(dirPath));
    }
  }

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.post("/api/generate-content", async (req, res): Promise<any> => {
    try {
      const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
      if (!apiKey) {
        return res.status(503).json({
          error: "API key is not configured. Please add your GEMINI_API_KEY in Settings > Secrets.",
        });
      }
      const ai = createAiClient(apiKey);
      const params = { ...req.body, model: resolveModel(req.body?.model) };
      const response = await ai.models.generateContent(params);
      return res.json(serializeGenerateContentResponse(response));
    } catch (error: any) {
      console.error("[Backend] /api/generate-content error:", error);
      return res.status(500).json({ error: error.message || "Failed to generate content." });
    }
  });

  app.post("/api/generate-content-stream", async (req, res): Promise<any> => {
    try {
      const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
      if (!apiKey) {
        return res.status(503).json({
          error: "API key is not configured. Please add your GEMINI_API_KEY in Settings > Secrets.",
        });
      }
      const ai = createAiClient(apiKey);
      const params = { ...req.body, model: resolveModel(req.body?.model) };
      const stream = await ai.models.generateContentStream(params);
      res.setHeader("Content-Type", "application/x-ndjson");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      for await (const chunk of stream) {
        res.write(JSON.stringify(serializeGenerateContentResponse(chunk)) + "\n");
      }
      res.end();
    } catch (error: any) {
      console.error("[Backend] /api/generate-content-stream error:", error);
      if (!res.headersSent) {
        return res.status(500).json({ error: error.message || "Failed to stream content." });
      }
      res.end();
    }
  });

  app.post("/api/chat-message", async (req, res): Promise<any> => {
    try {
      const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
      if (!apiKey) {
        return res.status(503).json({
          error: "API key is not configured. Please add your GEMINI_API_KEY in Settings > Secrets.",
        });
      }
      const { sessionId, model, config, history, message, msgConfig } = req.body || {};
      const ai = createAiClient(apiKey);
      const chatKey = sessionId ? `${getClientKey(req)}:${String(sessionId).slice(0, 128)}` : "";
      let chat = chatKey ? chats.get(chatKey) : undefined;
      if (!chat) {
        chat = ai.chats.create({
          model: resolveModel(model),
          config,
          history,
        });
        if (chatKey) chats.set(chatKey, chat);
      }
      const response = await chat.sendMessage({ message, config: msgConfig });
      return res.json(serializeGenerateContentResponse(response));
    } catch (error: any) {
      console.error("[Backend] /api/chat-message error:", error);
      return res.status(500).json({ error: error.message || "Failed to send chat message." });
    }
  });

  app.post("/api/chat-stream", async (req, res): Promise<any> => {
    try {
      const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
      if (!apiKey) {
        return res.status(503).json({
          error: "API key is not configured. Please add your GEMINI_API_KEY in Settings > Secrets.",
        });
      }
      const { sessionId, model, config, history, message, msgConfig } = req.body || {};
      const ai = createAiClient(apiKey);
      const chatKey = sessionId ? `${getClientKey(req)}:${String(sessionId).slice(0, 128)}` : "";
      let chat = chatKey ? chats.get(chatKey) : undefined;
      if (!chat) {
        chat = ai.chats.create({
          model: resolveModel(model),
          config,
          history,
        });
        if (chatKey) chats.set(chatKey, chat);
      }
      const stream = await chat.sendMessageStream({ message, config: msgConfig });
      res.setHeader("Content-Type", "application/x-ndjson");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      for await (const chunk of stream) {
        res.write(JSON.stringify(serializeGenerateContentResponse(chunk)) + "\n");
      }
      res.end();
    } catch (error: any) {
      console.error("[Backend] /api/chat-stream error:", error);
      if (!res.headersSent) {
        return res.status(500).json({ error: error.message || "Failed to stream chat message." });
      }
      res.end();
    }
  });

  app.post("/api/generate-images", async (req, res): Promise<any> => {
    try {
      const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
      if (!apiKey) {
        return res.status(503).json({
          error: "API key is not configured. Please add your GEMINI_API_KEY in Settings > Secrets.",
        });
      }
      const ai = createAiClient(apiKey);
      const response = await ai.models.generateImages({ ...req.body, model: resolveModel(req.body?.model || "imagen-3.0-generate-002") });
      return res.json(response);
    } catch (error: any) {
      console.error("[Backend] /api/generate-images error:", error);
      return res.status(500).json({ error: error.message || "Failed to generate images." });
    }
  });

  app.post("/api/generate-videos", async (req, res): Promise<any> => {
    try {
      const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
      if (!apiKey) {
        return res.status(503).json({
          error: "API key is not configured. Please add your GEMINI_API_KEY in Settings > Secrets.",
        });
      }
      const ai = createAiClient(apiKey);
      const body = { ...req.body };
      delete body.video;
      if (body.video && typeof body.video === 'object') { const c = { ...body.video }; delete c.uri; delete c.videoUri; body.video = Object.keys(c).length ? c : undefined; }
      delete body.source;
      body.model = resolveModel(body.model || "veo-3.1-fast-generate-preview");
      const op = await ai.models.generateVideos(body);
      if (op.name) {
        videoOps.set(op.name, { op, ownerKey: getClientKey(req) });
      }
      return res.json({
        name: op.name,
        done: op.done,
        metadata: op.metadata,
        error: op.error,
        response: op.response,
      });
    } catch (error: any) {
      console.error("[Backend] /api/generate-videos error:", error);
      return res.status(500).json({ error: error.message || "Failed to start video generation." });
    }
  });

  app.post("/api/videos-operation", async (req, res): Promise<any> => {
    try {
      const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
      if (!apiKey) {
        return res.status(503).json({
          error: "API key is not configured. Please add your GEMINI_API_KEY in Settings > Secrets.",
        });
      }
      const ai = createAiClient(apiKey);
      const opName = req.body?.operation?.name;
      const storedOp = opName ? videoOps.get(opName) : undefined;
      if (!storedOp) {
        return res.status(404).json({ error: "Video operation not found on server." });
      }
      const op = await ai.operations.getVideosOperation({ operation: storedOp.op });
      if (op.name) {
        videoOps.set(op.name, { op, ownerKey: getClientKey(req) });
      }
      const responseCopy = op.response ? JSON.parse(JSON.stringify(op.response)) : undefined;
      if (op.done && responseCopy?.generatedVideos) {
        for (const gv of responseCopy.generatedVideos) {
          if (gv.video?.uri) {
            const b64 = Buffer.from(gv.video.uri, "utf-8").toString("base64url");
            gv.video.uri = `/api/video-download?b64=${b64}`;
          }
        }
      }
      return res.json({
        name: op.name,
        done: op.done,
        metadata: op.metadata,
        error: op.error,
        response: responseCopy,
      });
    } catch (error: any) {
      console.error("[Backend] /api/videos-operation error:", error);
      return res.status(500).json({ error: error.message || "Failed to poll video operation." });
    }
  });

  app.get("/api/video-download", (_req, res) => {
    res.status(404).json({ error: "Video download is not enabled for this applet." });
  });

  const IMPERSONATION_BLOCK_PATTERNS: RegExp[] = [
    /\b(celebrity|celebrities|famous actor|politician|president|prime minister)\b/i,
    /\b(impersonate|imitate|mimic|sound\s+just\s+like|deepfake|without\s+permission|unauthorized)\b/i,
    /\b(mahesh babu|allu arjun|prabhas|pawan kalyan|chiranjeevi|jr ntr|ram charan|nani|vijay deverakonda|narendra modi|donald trump|joe biden|elon musk|taylor swift|virat kohli|amitabh bachchan|rajinikanth|shah rukh khan|salman khan)\b/i,
  ];

  function checkEthicalVoicePolicy(text: string): string | null {
    if (!text) return null;
    for (const pattern of IMPERSONATION_BLOCK_PATTERNS) {
      if (pattern.test(text)) {
        return "Ethical Voice Policy: Imitating celebrities, public figures, or cloning someone else's voice without explicit permission is not allowed. Please create an original AI persona or clone only your own / consented voice.";
      }
    }
    return null;
  }

  function buildAccentAndLanguageDirection(
    language: string,
    accent?: string,
    gamingStyle?: string
  ): string {
    const parts: string[] = [];
    if (language === "Telugu") {
      parts.push(
        "Speak in fluent, natural Telugu (te-IN) with accurate Telugu vowel lengths, crisp retroflex consonants, and natural pauses between clauses and sentences."
      );
      if (accent === "Andhra") {
        parts.push(
          "Use an authentic Coastal Andhra / Vijayawada-Guntur Telugu accent with melodic intonation, smooth vowel elongation, and warm conversational phrasing."
        );
      } else if (accent === "Telangana") {
        parts.push(
          "Use an authentic Telangana / Hyderabad Telugu accent with punchy rhythm, crisp earthy cadence, and natural local conversational inflection."
        );
      }
    } else if (language === "Tanglish") {
      parts.push(
        "Speak in natural Telugu + English code-switched Tanglish, smoothly blending idiomatic Telugu expressions with crisp modern English gaming/conversational terms and natural sentence pauses."
      );
      if (accent === "Andhra") {
        parts.push("Carry an expressive Andhra Telugu accent across the Tanglish code-switching.");
      } else if (accent === "Telangana") {
        parts.push("Carry a lively Telangana / Hyderabadi Telugu accent across the Tanglish code-switching.");
      }
    } else if (accent && accent !== "Standard" && accent !== "Auto") {
      parts.push(`Speak in clear English with an authentic ${accent} accent and natural cadence.`);
    }
    if (gamingStyle) {
      parts.push(`Delivery mode: ${gamingStyle}.`);
    }
    return parts.join(" ");
  }

  app.post("/api/voice-studio/design", async (req, res): Promise<any> => {
    try {
      const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
      if (!apiKey) {
        return res.status(503).json({
          error: "API key is not configured. Please add your GEMINI_API_KEY in Settings > Secrets.",
        });
      }

      const {
        description,
        availableVoices,
        language,
        teluguAccent,
        gender,
        ageImpression,
        styleCategory,
        emotion,
        energy,
        speed,
        pitchLevel,
        gamingMode,
      } = req.body || {};

      if (!description || typeof description !== "string" || !description.trim()) {
        return res.status(400).json({ error: "Please enter a description of the voice you want to create." });
      }

      const policyError = checkEthicalVoicePolicy(description);
      if (policyError) {
        return res.status(400).json({ error: policyError });
      }

      const targetLang =
        language === "Telugu" ? "Telugu" : language === "Tanglish" ? "Tanglish" : "English";
      const accent =
        teluguAccent === "Andhra" || teluguAccent === "Telangana" ? teluguAccent : "Standard";
      const ai = createAiClient(apiKey);
      const voiceCatalog = Array.isArray(availableVoices) ? availableVoices : [];

      const languageGuidance =
        targetLang === "Telugu"
          ? `Target Language: Telugu (తెలుగు / te-IN), Accent: ${accent} Telugu.
- stylePrompt MUST instruct natural, fluent Telugu pronunciation, ${accent === "Standard" ? "authentic conversational Telugu" : `${accent} regional Telugu`} intonation, and natural sentence pauses.
- sampleText MUST be written in natural, idiomatic Telugu script (తెలుగు లిపి) — 1 to 3 expressive sentences with natural pauses.`
          : targetLang === "Tanglish"
          ? `Target Language: Tanglish (Telugu + English mixed code-switching), Accent: ${accent} Telugu.
- stylePrompt MUST instruct seamless Telugu-English code-switching with ${accent} Telugu inflection, punchy comedic/conversational timing, and clear pronunciation of both Telugu and English words.
- sampleText MUST mix natural Telugu (in తెలుగు script or natural conversational Telugu) and English gaming/everyday phrases cleanly across 1 to 3 expressive sentences.`
          : `Target Language: English.
- sampleText MUST be written in natural English — 1 to 3 expressive sentences with natural phrasing.`;

      const studioControlsContext = [
        gender && gender !== "Auto" ? `Preferred Gender: ${gender}` : "",
        ageImpression ? `Age Impression: ${ageImpression}` : "",
        styleCategory ? `Voice Style: ${styleCategory}` : "",
        emotion ? `Primary Emotion: ${emotion}` : "",
        typeof energy === "number" ? `Energy Level: ${energy}/100` : "",
        typeof speed === "number" ? `Speaking Pace: ${speed}x` : "",
        pitchLevel ? `Pitch Preference: ${pitchLevel}` : "",
        gamingMode ? "Gaming Voice Mode: ACTIVE (punchy commentator reactions, expressive rhythm, zero robotic stiffness)" : "",
      ]
        .filter(Boolean)
        .join("\n");

      const prompt = `You are a master vocal casting director and voice designer for Gemini 3.8 Flash TTS.
Design an ORIGINAL custom voice persona from the user's description (never imitate real celebrities or public figures). Select the closest base timbre from the available voices and craft a rich vocal style direction.

Available base voices:
${JSON.stringify(voiceCatalog)}

${languageGuidance}

${studioControlsContext ? `Requested Vocal Parameters:\n${studioControlsContext}\n` : ""}
User's Voice Concept: "${description.trim()}"

Return JSON with:
- suggestedName: A memorable original 1-2 word name for this custom voice (do not reuse an existing base voice name or celebrity name).
- baseVoice: Exact name of the best matching base voice from the available list.
- gender: "Female" or "Male" matching the persona.
- pitch: One of "Low", "Medium-Low", "Medium", "Medium-High", "High".
- ageImpression: Short label such as "Young Male Gamer (18-24)", "Young Adult (20s)", "Mid-30s", or "Mature".
- styleCategory: Best matching style from ["Funny", "Energetic", "Friendly", "Soft", "Cinematic", "Gaming Commentary", "Sarcastic Comedy", "Dramatic Storytelling"].
- emotion: Short emotional tone label (e.g., "Playful", "Hyped", "Sarcastic", "Warm", "Dramatic", "Calm").
- characteristics: 4 or 5 short descriptive tags (e.g., ["Energetic", "Telugu Gamer", "Witty", "Expressive"]).
- stylePrompt: Concise, vivid speech direction describing tone, cadence, age impression, ${targetLang !== "English" ? `${accent} Telugu accent, ` : ""}breathing, natural pauses, and emotional texture (1-2 sentences).
- sampleText: A 1-3 sentence audition script written in character in ${targetLang}. You may sparingly use expressive markers like <breath>, <laugh>, or <gasp> if natural for the persona.`;

      const response = await ai.models.generateContent({
        model: "gemini-4-hydrogen",
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              suggestedName: { type: Type.STRING },
              baseVoice: { type: Type.STRING },
              gender: { type: Type.STRING },
              pitch: { type: Type.STRING },
              ageImpression: { type: Type.STRING },
              styleCategory: { type: Type.STRING },
              emotion: { type: Type.STRING },
              characteristics: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              stylePrompt: { type: Type.STRING },
              sampleText: { type: Type.STRING },
            },
          },
        },
      });

      const parsed = JSON.parse(response.text || "{}");
      return res.json(parsed);
    } catch (error: any) {
      console.error("[Backend] /api/voice-studio/design error:", error);
      return res.status(error?.status || 500).json({
        error: error?.message || "Failed to design voice persona.",
      });
    }
  });

  app.post("/api/voice-studio/design-variations", async (req, res): Promise<any> => {
    try {
      const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
      if (!apiKey) {
        return res.status(503).json({
          error: "Gemini API key is not configured. Please add your GEMINI_API_KEY in Settings > Secrets.",
        });
      }

      const {
        description,
        availableVoices,
        language,
        accent,
        gender,
        ageImpression,
        pitchLevel,
        speed,
        pitchSemitones,
        energy,
        emotion,
        personality,
        customScript,
        variationCount,
      } = req.body || {};

      if (!description || typeof description !== "string" || !description.trim()) {
        return res.status(400).json({ error: "Please enter a natural language description of the voice you want to create." });
      }

      const policyError = checkEthicalVoicePolicy(`${description} ${customScript || ""}`);
      if (policyError) {
        return res.status(400).json({ error: policyError });
      }

      const targetLang =
        language === "Telugu" ? "Telugu" : language === "Tanglish" ? "Tanglish" : "English";
      const regionAccent = typeof accent === "string" && accent.trim() ? accent.trim() : "Standard";
      const count = Math.min(3, Math.max(1, Number(variationCount) || 3));
      const voiceCatalog = Array.isArray(availableVoices) ? availableVoices : [];
      const ai = createAiClient(apiKey);

      const languageGuidance =
        targetLang === "Telugu"
          ? `Target Language: Telugu (తెలుగు / te-IN), Accent: ${regionAccent}.
- stylePrompt MUST direct authentic ${regionAccent} Telugu pronunciation, vowel elongation, natural conversational rhythm, and natural pauses.
- sampleText MUST be written in natural, expressive Telugu script (తెలుగు లిపి) matching the persona.`
          : targetLang === "Tanglish"
          ? `Target Language: Tanglish (Natural Telugu + English code-switching), Accent: ${regionAccent}.
- stylePrompt MUST instruct effortless Telugu + English mixed speech with ${regionAccent} inflection and expressive timing.
- sampleText MUST mix conversational Telugu (తెలుగు) and natural English phrases seamlessly.`
          : `Target Language: English, Accent: ${regionAccent}.
- stylePrompt MUST capture the ${regionAccent} accent flavor, vocal texture, pacing, and pauses.
- sampleText MUST be expressive natural English matching the persona.`;

      const controlsSpec = [
        gender && gender !== "Auto" ? `Gender Presentation: ${gender}` : "",
        ageImpression ? `Perceived Age: ${ageImpression}` : "",
        pitchLevel ? `Pitch Profile: ${pitchLevel}` : "",
        typeof speed === "number" ? `Speaking Speed: ${speed}x` : "",
        typeof pitchSemitones === "number" && pitchSemitones !== 0 ? `Pitch Offset: ${pitchSemitones > 0 ? "+" : ""}${pitchSemitones} semitones` : "",
        typeof energy === "number" ? `Energy Level: ${energy}/100` : "",
        emotion ? `Primary Emotion: ${emotion}` : "",
        personality ? `Voice Personality: ${personality}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      const designPrompt = `You are a lead AI voice designer casting original vocal personas for Gemini 3.8 Flash TTS.
Design ${count} DISTINCT, ORIGINAL voice variations based on the user's description and vocal parameters.
Never imitate real celebrities or public figures. Choose DIFFERENT matching baseVoice timbres from the available catalog so each variation sounds genuinely distinct.

Available base voices:
${JSON.stringify(voiceCatalog)}

${languageGuidance}

${controlsSpec ? `Requested Customization Controls:\n${controlsSpec}\n` : ""}
User Voice Description: "${description.trim()}"
${customScript && typeof customScript === "string" && customScript.trim() ? `User Audition Script (preserve or subtly adapt pauses for delivery): "${customScript.trim()}"` : ""}

Return JSON with a "variations" array of ${count} items. Each variation item MUST have:
- variationLabel: Short distinguishing label (e.g. "Variation A · Punchy & Fast", "Variation B · Warm & Smooth", "Variation C · Expressive Storyteller").
- suggestedName: Memorable original 1-2 word persona name (distinct across all ${count} variations).
- baseVoice: Exact matching voice name from the available list (use a DIFFERENT baseVoice for each variation when possible).
- gender: Matching gender ("Male" or "Female").
- pitch: One of "Low", "Medium-Low", "Medium", "Medium-High", "High".
- ageImpression: Short perceived age label.
- styleCategory: Style label (e.g. "Gaming Commentary", "Funny", "Soft", "Horror Narrator", "Cartoon", "Storyteller", "Cinematic").
- emotion: Emotional delivery label.
- personality: Short personality trait summary.
- characteristics: 4-5 concise descriptive tags.
- stylePrompt: Vivid 1-2 sentence performance direction specifying timbre, age impression, ${regionAccent} accent, pacing, emotion, and natural pauses.
- sampleText: ${customScript && String(customScript).trim() ? "The user's script with optional natural pause punctuation." : `A fresh 1-2 sentence audition line in ${targetLang} showcasing this variation's personality (may include up to 1 vocal cue like <laugh>, <breath>, or <gasp> when natural).`}`;

      const designResp = await ai.models.generateContent({
        model: "gemini-4-hydrogen",
        contents: designPrompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              variations: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    variationLabel: { type: Type.STRING },
                    suggestedName: { type: Type.STRING },
                    baseVoice: { type: Type.STRING },
                    gender: { type: Type.STRING },
                    pitch: { type: Type.STRING },
                    ageImpression: { type: Type.STRING },
                    styleCategory: { type: Type.STRING },
                    emotion: { type: Type.STRING },
                    personality: { type: Type.STRING },
                    characteristics: {
                      type: Type.ARRAY,
                      items: { type: Type.STRING },
                    },
                    stylePrompt: { type: Type.STRING },
                    sampleText: { type: Type.STRING },
                  },
                },
              },
            },
          },
        },
      });

      const parsed = JSON.parse(designResp.text || "{}");
      const rawVariations = Array.isArray(parsed?.variations) ? parsed.variations.slice(0, count) : [];
      if (rawVariations.length === 0) {
        return res.status(502).json({ error: "Voice designer did not return any voice variations. Please try refining your description." });
      }

      const synthResults = await Promise.allSettled(
        rawVariations.map(async (v: any, idx: number) => {
          const textToSpeak =
            customScript && typeof customScript === "string" && customScript.trim()
              ? customScript.trim()
              : String(v.sampleText || "").trim() || "Hello, welcome to Voice Design Studio!";
          const baseVoiceName =
            typeof v.baseVoice === "string" && voiceCatalog.some((cv: any) => cv.name === v.baseVoice)
              ? v.baseVoice
              : voiceCatalog[idx % Math.max(1, voiceCatalog.length)]?.name || "Puck";

          const langDir = buildAccentAndLanguageDirection(targetLang, regionAccent);
          const extraDirs = [
            langDir,
            v.ageImpression ? `Perceived age: ${v.ageImpression}.` : "",
            v.emotion ? `Emotion: ${v.emotion}.` : "",
            v.personality ? `Personality: ${v.personality}.` : "",
            typeof energy === "number" && energy >= 75
              ? "High vocal energy and punchy projection."
              : typeof energy === "number" && energy <= 35
              ? "Soft, relaxed, low-energy warmth."
              : "",
            v.stylePrompt || "",
          ]
            .filter(Boolean)
            .join(" ");

          const ttsResp = await ai.models.generateContent({
            model: "gemini-3.8-flash-tts",
            contents: [
              {
                role: "user",
                parts: [
                  {
                    text: textToSpeak,
                    speechMetadata: { style: extraDirs.slice(0, 650) },
                  },
                ],
              },
            ],
            config: {
              responseModalities: ["AUDIO"],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName: baseVoiceName },
                },
              },
            },
          });

          const inlineData = ttsResp.candidates?.[0]?.content?.parts?.[0]?.inlineData;
          return {
            id: `var_${Date.now()}_${idx}`,
            variationLabel: v.variationLabel || `Variation ${idx + 1}`,
            suggestedName: v.suggestedName || `Persona ${idx + 1}`,
            baseVoice: baseVoiceName,
            gender: v.gender || (gender && gender !== "Auto" ? gender : "Male"),
            pitch: v.pitch || pitchLevel || "Medium",
            ageImpression: v.ageImpression || ageImpression || "Young Adult",
            styleCategory: v.styleCategory || "Custom Design",
            emotion: v.emotion || emotion || "Expressive",
            personality: v.personality || personality || "Natural",
            characteristics: Array.isArray(v.characteristics) ? v.characteristics : [],
            stylePrompt: v.stylePrompt || "",
            sampleText: textToSpeak,
            audioBase64: inlineData?.data || null,
            audioError: inlineData?.data ? null : "TTS audio was empty for this variation.",
          };
        })
      );

      const finalVariations = synthResults.map((result, idx) => {
        const v = rawVariations[idx] || {};
        if (result.status === "fulfilled") {
          return result.value;
        }
        return {
          id: `var_${Date.now()}_${idx}`,
          variationLabel: v.variationLabel || `Variation ${idx + 1}`,
          suggestedName: v.suggestedName || `Persona ${idx + 1}`,
          baseVoice: v.baseVoice || "Puck",
          gender: v.gender || "Male",
          pitch: v.pitch || "Medium",
          ageImpression: v.ageImpression || ageImpression || "Young Adult",
          styleCategory: v.styleCategory || "Custom Design",
          emotion: v.emotion || emotion || "Expressive",
          personality: v.personality || personality || "Natural",
          characteristics: Array.isArray(v.characteristics) ? v.characteristics : [],
          stylePrompt: v.stylePrompt || "",
          sampleText: v.sampleText || "",
          audioBase64: null,
          audioError: result.reason?.message || "Failed to synthesize audio for this variation.",
        };
      });

      return res.json({ variations: finalVariations });
    } catch (error: any) {
      console.error("[Backend] /api/voice-studio/design-variations error:", error);
      return res.status(error?.status || 500).json({
        error: error?.message || "Failed to design voice variations.",
      });
    }
  });

  app.post("/api/voice-studio/clone", async (req, res): Promise<any> => {
    try {
      const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
      if (!apiKey) {
        return res.status(503).json({
          error: "API key is not configured. Please add your GEMINI_API_KEY in Settings > Secrets.",
        });
      }

      const {
        audioBase64,
        mimeType,
        targetLanguage,
        teluguAccent,
        availableVoices,
        consentConfirmed,
        speakerLabel,
      } = req.body || {};

      if (consentConfirmed !== true) {
        return res.status(400).json({
          error: "Ethical consent confirmation is required before analyzing or cloning a voice sample.",
        });
      }

      if (typeof speakerLabel === "string") {
        const policyError = checkEthicalVoicePolicy(speakerLabel);
        if (policyError) {
          return res.status(400).json({ error: policyError });
        }
      }

      if (!audioBase64 || typeof audioBase64 !== "string") {
        return res.status(400).json({ error: "Reference audio recording or file is required for ethical voice cloning." });
      }

      const rawMime = typeof mimeType === "string" ? mimeType.split(";")[0].trim().toLowerCase() : "audio/wav";
      const cleanMime =
        rawMime === "audio/x-m4a" || rawMime === "audio/m4a"
          ? "audio/mp4"
          : rawMime === "audio/mp3"
          ? "audio/mpeg"
          : rawMime.startsWith("audio/")
          ? rawMime
          : "audio/wav";
      const lang =
        targetLanguage === "Telugu" ? "Telugu" : targetLanguage === "Tanglish" ? "Tanglish" : "English";
      const accent =
        teluguAccent === "Andhra" || teluguAccent === "Telangana" ? teluguAccent : "Standard";
      const voiceCatalog = Array.isArray(availableVoices) ? availableVoices : [];
      const ai = createAiClient(apiKey);

      const langInstruction =
        lang === "Telugu"
          ? `explicitly instructing natural, fluent native Telugu (తెలుగు / te-IN) pronunciation with ${accent === "Standard" ? "natural Telugu" : `${accent} regional Telugu`} cadence and sentence pauses`
          : lang === "Tanglish"
          ? `explicitly instructing natural Telugu + English code-switching (Tanglish) with ${accent === "Standard" ? "natural Telugu" : `${accent} regional Telugu`} intonation`
          : "capturing the speaker's natural English delivery";

      const sampleGuidance =
        lang === "Telugu"
          ? "natural Telugu script (తెలుగు) with natural sentence pauses"
          : lang === "Tanglish"
          ? "natural Telugu + English code-switched Tanglish"
          : "natural English";

      const prompt = `You are an expert acoustic voice profiler and casting director for Gemini 3.8 Flash TTS.
The user has confirmed explicit consent to create a style-matched voice profile from their own or permitted voice clip.
Listen carefully to the attached reference voice audio clip. Analyze the speaker's vocal timbre, fundamental pitch register, gender presentation, age impression, speaking pace, cadence, accent/language inflection, breathiness, resonance, and emotional tone.

Available base voices to match:
${JSON.stringify(voiceCatalog)}

Target Output Language: ${lang}${lang !== "English" ? ` (${accent} accent)` : ""}

Task:
1. Select the closest matching baseVoice from the available list.
2. Summarize what you heard in the speaker's voice in 1 concise sentence (detectedTraitsSummary).
3. Create a vivid stylePrompt (1-2 sentences) capturing the speaker's exact cadence, pitch feel, warmth/texture, pacing, and delivery style, ${langInstruction}.
4. Write a 1-2 sentence audition sampleText in ${sampleGuidance} matching the speaker's conversational style.
5. Suggest a short 1-2 word voice name (suggestedName), ageImpression, emotion, and 4-5 characteristic tags.`;

      const response = await ai.models.generateContent({
        model: "gemini-4-hydrogen",
        contents: {
          parts: [
            {
              inlineData: {
                mimeType: cleanMime,
                data: audioBase64,
              },
            },
            { text: prompt },
          ],
        },
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              suggestedName: { type: Type.STRING },
              baseVoice: { type: Type.STRING },
              gender: { type: Type.STRING },
              pitch: { type: Type.STRING },
              ageImpression: { type: Type.STRING },
              emotion: { type: Type.STRING },
              characteristics: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              detectedTraitsSummary: { type: Type.STRING },
              stylePrompt: { type: Type.STRING },
              sampleText: { type: Type.STRING },
            },
          },
        },
      });

      const parsed = JSON.parse(response.text || "{}");
      return res.json(parsed);
    } catch (error: any) {
      console.error("[Backend] /api/voice-studio/clone error:", error);
      return res.status(error?.status || 500).json({
        error: error?.message || "Failed to analyze reference audio for voice cloning.",
      });
    }
  });

  app.post("/api/voice-studio/gaming-script", async (req, res): Promise<any> => {
    try {
      const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
      if (!apiKey) {
        return res.status(503).json({
          error: "API key is not configured. Please add your GEMINI_API_KEY in Settings > Secrets.",
        });
      }

      const { mode, language, accent, topic } = req.body || {};
      const lang = language === "Telugu" ? "Telugu" : language === "Tanglish" ? "Tanglish" : "English";
      const region = accent === "Andhra" || accent === "Telangana" ? accent : "Standard";
      const gamingMode = typeof mode === "string" && mode.trim() ? mode.trim() : "Funny Telugu Gaming Commentary";

      const policyError = checkEthicalVoicePolicy(`${gamingMode} ${topic || ""}`);
      if (policyError) {
        return res.status(400).json({ error: policyError });
      }

      const ai = createAiClient(apiKey);
      const prompt = `Write a short, punchy 2-3 sentence voice-over script for a gaming / creator AI voice studio.
Mode: ${gamingMode}
Language: ${lang}${lang !== "English" ? ` (Accent flavor: ${region} Telugu)` : ""}
${topic ? `Topic/Scenario: ${String(topic).slice(0, 200)}` : ""}

Guidelines:
- If Language is "Telugu", write in natural, conversational Telugu script (తెలుగు) using authentic ${region} slang/expressions and natural commas/ellipses for realistic pauses.
- If Language is "Tanglish", mix conversational Telugu (తెలుగు words or readable Telugu+English) with natural English gaming callouts (e.g., clutch, noob, revive, OP, lobby, lag, squad wipe) like real Telugu gamers speak.
- If Language is "English", write expressive creator/gaming dialogue.
- Sparingly include up to 1-2 Gemini TTS vocal tags like <laugh>, <breath>, or <gasp> where they elevate comedic timing.
- Keep it clean, original, and never reference or imitate real celebrities.

Return JSON with:
- script: The ready-to-speak script string.
- styleTip: A 1-sentence performance direction matching the mode and accent.`;

      const response = await ai.models.generateContent({
        model: "gemini-4-hydrogen",
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              script: { type: Type.STRING },
              styleTip: { type: Type.STRING },
            },
          },
        },
      });

      const parsed = JSON.parse(response.text || "{}");
      return res.json(parsed);
    } catch (error: any) {
      console.error("[Backend] /api/voice-studio/gaming-script error:", error);
      return res.status(error?.status || 500).json({
        error: error?.message || "Failed to generate gaming script.",
      });
    }
  });

  app.post("/api/voice-studio/conversation-generate", async (req, res): Promise<any> => {
    try {
      const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
      if (!apiKey) {
        return res.status(503).json({
          error: "Gemini API key is not configured. Please add your GEMINI_API_KEY in Settings > Secrets.",
        });
      }

      const {
        sceneType,
        language,
        accent,
        characterCount,
        lineCount,
        topic,
        availableVoices,
      } = req.body || {};

      const lang = language === "Telugu" ? "Telugu" : language === "Tanglish" ? "Tanglish" : "English";
      const regionAccent =
        accent === "Andhra" || accent === "Telangana" ? accent : "Standard";
      const charsNum = Math.min(10, Math.max(2, Number(characterCount) || 3));
      const linesNum = Math.min(24, Math.max(charsNum, Number(lineCount) || Math.max(6, charsNum * 2)));
      const scene = typeof sceneType === "string" && sceneType.trim() ? sceneType.trim() : "Comedy Scene";
      const topicText = typeof topic === "string" ? topic.trim() : "";

      const policyError = checkEthicalVoicePolicy(`${scene} ${topicText}`);
      if (policyError) {
        return res.status(400).json({ error: policyError });
      }

      const voiceCatalog = Array.isArray(availableVoices) ? availableVoices : [];
      const ai = createAiClient(apiKey);

      const languageDirection =
        lang === "Telugu"
          ? `Write ALL dialogue in natural, fluent Telugu script (తెలుగు లిపి) reflecting an authentic ${regionAccent} Telugu flavor with commas/ellipses for natural pauses.`
          : lang === "Tanglish"
          ? `Write ALL dialogue in lively Tanglish (natural Telugu + English code-switching as real speakers talk in Hyderabad/Andhra, blending Telugu script phrases and modern English words).`
          : `Write ALL dialogue in natural, expressive English.`;

      const prompt = `You are an expert screenplay writer and vocal casting director for a multi-character AI Voice Studio.
Create a vivid ${scene} dialogue with EXACTLY ${charsNum} distinct characters and roughly ${linesNum} snappy, realistic dialogue lines.
${topicText ? `Scenario / Premise: "${topicText.slice(0, 350)}"` : ""}
${languageDirection}
Never imitate or reference real celebrities or public figures. Create original fictional character names.

Available AI Voices to cast from:
${JSON.stringify(voiceCatalog)}

Casting & Dialogue Rules:
- Return "characters": array of EXACTLY ${charsNum} items. Assign a DIFFERENT voiceName from Available AI Voices to each character whenever possible, matching their role/gender/mood (male, female, funny, energetic, calm, scary, narrator, gaming).
- Each character item: { name, role (short role like "Funny Friend", "Calm Host", "Spooky Narrator", "Hyper Gamer"), voiceName (exact match from Available AI Voices) }.
- Return "lines": array of ${linesNum} dialogue items. Each item MUST reference one character by exact "characterName".
- Each line item: { characterName, text, emotion (e.g. "Funny", "Excited", "Angry", "Calm", "Scared", "Sarcastic", "Curious", "Dramatic"), speakingStyle (e.g. "Fast & Punchy", "Conversational", "Whispered Suspense", "Gaming Callout", "Storyteller"), sfxCue (one of "none", "comedy-pop", "gaming-ding", "horror-sting", "transition-whoosh", "applause-swell" — use "none" on most lines and add 1-2 cues where dramatic/funny) }.
- Sparingly include up to 1 vocal expression marker (<laugh>, <breath>, or <gasp>) on lines where it sounds natural.`;

      const response = await ai.models.generateContent({
        model: "gemini-4-hydrogen",
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              characters: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    name: { type: Type.STRING },
                    role: { type: Type.STRING },
                    voiceName: { type: Type.STRING },
                  },
                },
              },
              lines: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    characterName: { type: Type.STRING },
                    text: { type: Type.STRING },
                    emotion: { type: Type.STRING },
                    speakingStyle: { type: Type.STRING },
                    sfxCue: { type: Type.STRING },
                  },
                },
              },
            },
          },
        },
      });

      const parsed = JSON.parse(response.text || "{}");
      return res.json(parsed);
    } catch (error: any) {
      console.error("[Backend] /api/voice-studio/conversation-generate error:", error);
      return res.status(error?.status || 500).json({
        error: error?.message || "Failed to generate conversation script.",
      });
    }
  });

  app.post("/api/voice-studio/conversation-autocast", async (req, res): Promise<any> => {
    try {
      const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
      if (!apiKey) {
        return res.status(503).json({
          error: "Gemini API key is not configured. Please add your GEMINI_API_KEY in Settings > Secrets.",
        });
      }

      const { characters, sceneType, availableVoices } = req.body || {};
      if (!Array.isArray(characters) || characters.length < 2) {
        return res.status(400).json({ error: "Provide at least 2 characters to auto-assign voices." });
      }

      const voiceCatalog = Array.isArray(availableVoices) ? availableVoices : [];
      const ai = createAiClient(apiKey);

      const prompt = `You are a vocal casting director. Automatically assign a DISTINCT, best-fitting AI voice from Available Voices to each character in this ${sceneType || "conversation"}.
Do not repeat voiceName unless there are fewer available voices than characters.

Characters:
${JSON.stringify(characters)}

Available Voices:
${JSON.stringify(voiceCatalog)}

Return JSON with "assignments": array of { id, voiceName } matching every character's id.`;

      const response = await ai.models.generateContent({
        model: "gemini-4-hydrogen",
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              assignments: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    id: { type: Type.STRING },
                    voiceName: { type: Type.STRING },
                  },
                },
              },
            },
          },
        },
      });

      const parsed = JSON.parse(response.text || "{}");
      return res.json(parsed);
    } catch (error: any) {
      console.error("[Backend] /api/voice-studio/conversation-autocast error:", error);
      return res.status(error?.status || 500).json({
        error: error?.message || "Failed to auto-assign voices.",
      });
    }
  });

  app.post("/api/voice-studio/preview", async (req, res): Promise<any> => {
    try {
      const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
      if (!apiKey) {
        return res.status(503).json({
          error: "API key is not configured. Please add your GEMINI_API_KEY in Settings > Secrets.",
        });
      }

      const {
        text,
        baseVoice,
        stylePrompt,
        language,
        accent,
        ageImpression,
        emotion,
        energy,
        speed,
        pitchSemitones,
        gamingStyle,
      } = req.body || {};

      if (!text || typeof text !== "string" || !text.trim()) {
        return res.status(400).json({ error: "Sample text is required to generate speech." });
      }

      const policyError = checkEthicalVoicePolicy(`${stylePrompt || ""} ${text}`);
      if (policyError) {
        return res.status(400).json({ error: policyError });
      }

      const selectedBase = typeof baseVoice === "string" && baseVoice.trim() ? baseVoice.trim() : "Kore";
      const ai = createAiClient(apiKey);

      const directionPieces: string[] = [];
      const langDirection = buildAccentAndLanguageDirection(
        typeof language === "string" ? language : "English",
        typeof accent === "string" ? accent : "Standard",
        typeof gamingStyle === "string" ? gamingStyle : undefined
      );
      if (langDirection) directionPieces.push(langDirection);
      if (typeof ageImpression === "string" && ageImpression.trim()) {
        directionPieces.push(`Age impression: ${ageImpression.trim()}.`);
      }
      if (typeof emotion === "string" && emotion.trim()) {
        directionPieces.push(`Emotional delivery: ${emotion.trim()}.`);
      }
      if (typeof energy === "number") {
        if (energy >= 75) directionPieces.push("High vocal energy and punchy projection.");
        else if (energy <= 35) directionPieces.push("Soft, relaxed, low-energy intimacy.");
      }
      if (typeof speed === "number") {
        if (speed >= 1.15) directionPieces.push("Crisp, brisk speaking tempo.");
        else if (speed <= 0.88) directionPieces.push("Unhurried, deliberate pacing with natural pauses.");
      }
      if (typeof pitchSemitones === "number") {
        if (pitchSemitones >= 2) directionPieces.push("Slightly brighter, higher vocal register.");
        else if (pitchSemitones <= -2) directionPieces.push("Deeper, lower vocal register.");
      }
      if (typeof stylePrompt === "string" && stylePrompt.trim()) {
        directionPieces.push(stylePrompt.trim());
      }

      const finalStyle = directionPieces.join(" ").trim();

      const part: any = { text: text.trim() };
      if (finalStyle) {
        part.speechMetadata = { style: finalStyle };
      }

      const response = await ai.models.generateContent({
        model: "gemini-3.8-flash-tts",
        contents: [
          {
            role: "user",
            parts: [part],
          },
        ],
        config: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: selectedBase,
              },
            },
          },
        },
      });

      const inlineData = response.candidates?.[0]?.content?.parts?.[0]?.inlineData;
      if (!inlineData?.data) {
        return res.status(502).json({ error: "No audio data returned by TTS model." });
      }

      return res.json({
        audioBase64: inlineData.data,
        mimeType: inlineData.mimeType || "audio/wav",
      });
    } catch (error: any) {
      console.error("[Backend] /api/voice-studio/preview error:", error);
      return res.status(error?.status || 500).json({
        error: error?.message || "Failed to generate voice preview.",
      });
    }
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(["/server.cjs", "/server.cjs.map"], (_req: any, res: any) => res.status(404).end());
    app.use(express.static(distPath));
    app.use((_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[Backend] Server running on http://localhost:${PORT}`);
  });
}

startServer();
