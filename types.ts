/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type LanguageMode = 'English' | 'Telugu' | 'Tanglish';
export type TeluguAccent = 'Andhra' | 'Telangana' | 'Standard';
export type LibraryScope = 'all' | 'favorites' | 'custom' | 'gaming';
export type WorkspaceTab = 'library' | 'design' | 'conversation' | 'studio' | 'gaming' | 'files';

export type ConversationSceneType =
  | 'Funny Argument'
  | 'Comedy Scene'
  | 'Gaming Conversation'
  | 'Horror Storytelling'
  | 'Interview'
  | 'Podcast';

export type ConversationBgmPreset =
  | 'none'
  | 'podcast-lofi'
  | 'gaming-synth'
  | 'comedy-groove'
  | 'horror-drone';

export type ConversationSfxCue =
  | 'none'
  | 'comedy-pop'
  | 'gaming-ding'
  | 'horror-sting'
  | 'transition-whoosh'
  | 'applause-swell';

export interface ConversationCharacter {
  id: string;
  name: string;
  role: string;
  voiceName: string;
  accent?: string;
}

export interface ConversationLine {
  id: string;
  characterId: string;
  text: string;
  emotion: string;
  speakingStyle: string;
  sfxCue: ConversationSfxCue;
  status: 'idle' | 'generating' | 'ready' | 'error';
  audioBase64?: string | null;
  error?: string | null;
  durationSec?: number;
}

export type ImportedFileKind = 'audio' | 'script';

export interface ImportedFileRecord {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  formatLabel: string;
  kind: ImportedFileKind;
  createdAt: number;
  durationSec?: number;
  estimatedHz?: number | null;
  textContent?: string;
  blob: Blob;
}

export interface VoiceAnalysis {
  gender: string;
  pitch: string;
  characteristics: string[];
  visualDescription: string;
}

export interface Voice {
  name: string;
  pitch: string;
  characteristics: string[];
  audioSampleUrl: string;
  fileUri: string;
  analysis: VoiceAnalysis;
  imageUrl: string;
  // Custom, cloned & studio voice fields
  isCustom?: boolean;
  isCloned?: boolean;
  language?: LanguageMode | string;
  accent?: TeluguAccent | string;
  ageImpression?: string;
  styleCategory?: string;
  emotion?: string;
  personality?: string;
  speed?: number;
  pitchSemitones?: number;
  energy?: number;
  isGamingMode?: boolean;
  consentConfirmed?: boolean;
  baseVoice?: string;
  stylePrompt?: string;
  sampleText?: string;
}

export interface VoiceDesignSuggestion {
  suggestedName: string;
  baseVoice: string;
  gender: string;
  pitch: string;
  ageImpression?: string;
  styleCategory?: string;
  emotion?: string;
  personality?: string;
  characteristics: string[];
  stylePrompt: string;
  sampleText: string;
}

export interface VoiceDesignVariation extends VoiceDesignSuggestion {
  id: string;
  variationLabel: string;
  audioBase64?: string | null;
  audioError?: string | null;
}

export interface VoiceCloneAnalysis extends VoiceDesignSuggestion {
  detectedTraitsSummary: string;
}

export interface FilterState {
  gender: string | 'All';
  pitch: string | 'All';
  language: string | 'All';
  libraryScope: LibraryScope;
  search: string;
}

export interface AiRecommendation {
  voiceNames: string[];
  systemInstruction: string;
  sampleText: string;
  language?: string;
}