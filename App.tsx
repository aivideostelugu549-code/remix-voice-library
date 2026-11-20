/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useMemo, useEffect } from 'react';
import { VOICE_DATA } from './constants';
import Carousel3D from './components/Carousel3D';
import GridView from './components/GridView';
import FilterBar from './components/FilterBar';
import VoiceFinder from './components/VoiceFinder';
import VoiceCreatorModal from './components/VoiceCreatorModal';
import CompareVoicesModal from './components/CompareVoicesModal';
import AudioStudioView from './components/AudioStudioView';
import VoiceDesignStudioView from './components/VoiceDesignStudioView';
import BatchConversationStudioView from './components/BatchConversationStudioView';
import FileManagerView from './components/FileManagerView';
import AiResultCard from './components/AiResultCard';
import {
  FilterState,
  AiRecommendation,
  Voice,
  WorkspaceTab,
  LanguageMode,
  TeluguAccent,
  ImportedFileRecord,
} from './types';
import {
  Info,
  GitCompare,
  X,
  Library,
  FolderOpen,
  AudioLines,
  Gamepad2,
  Wand2,
  Users,
} from 'lucide-react';
import { unlockAudioContext, stopVoiceSample } from './utils/webAudioVoicePreview';
import {
  listVaultFiles,
  saveFilesToVault,
  deleteVaultFile,
  clearVaultFiles,
} from './utils/fileVault';

const CUSTOM_VOICES_STORAGE_KEY = 'gemini_custom_voices_v1';
const FAVORITE_VOICES_STORAGE_KEY = 'gemini_favorite_voices_v1';

const App: React.FC = () => {
  const [customVoices, setCustomVoices] = useState<Voice[]>(() => {
    try {
      const raw = localStorage.getItem(CUSTOM_VOICES_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch (e) {
      console.error('Failed to load custom voices:', e);
    }
    return [];
  });

  const [favoriteNames, setFavoriteNames] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(FAVORITE_VOICES_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch (e) {
      console.error('Failed to load favorite voices:', e);
    }
    return ['Puck', 'Kore', 'Fenrir'];
  });

  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>('library');
  const [studioVoiceName, setStudioVoiceName] = useState<string>(VOICE_DATA[0]?.name || 'Zephyr');
  const [playingVoice, setPlayingVoice] = useState<string | null>(null);
  const [aiResult, setAiResult] = useState<AiRecommendation | null>(null);
  const [isAiCardVisible, setIsAiCardVisible] = useState(false);
  const [showVoiceFinder, setShowVoiceFinder] = useState(false);
  const [showVoiceCreator, setShowVoiceCreator] = useState(false);
  const [compareSelection, setCompareSelection] = useState<string[]>([]);
  const [showCompareModal, setShowCompareModal] = useState(false);
  const [compareLaunchContext, setCompareLaunchContext] = useState<{
    script?: string;
    language?: LanguageMode;
    accent?: TeluguAccent;
  }>({});
  const [viewMode, setViewMode] = useState<'carousel' | 'grid'>('grid');
  const [isDarkMode, setIsDarkMode] = useState(true);
  const [activeIndex, setActiveIndex] = useState(0);

  // Private Local File Vault state
  const [vaultFiles, setVaultFiles] = useState<ImportedFileRecord[]>([]);
  const [isLoadingVault, setIsLoadingVault] = useState(true);
  const [creatorLaunchConfig, setCreatorLaunchConfig] = useState<{
    mode: 'design' | 'clone';
    cloneFile: ImportedFileRecord | null;
    consentConfirmed: boolean;
  }>({ mode: 'design', cloneFile: null, consentConfirmed: false });
  const [studioImportedScript, setStudioImportedScript] = useState<{
    id: string;
    name: string;
    content: string;
    version: number;
  } | null>(null);

  const [filters, setFilters] = useState<FilterState>({
    gender: 'All',
    pitch: 'All',
    language: 'All',
    libraryScope: 'all',
    search: '',
  });

  useEffect(() => {
    if (isDarkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [isDarkMode]);

  useEffect(() => {
    try {
      localStorage.setItem(CUSTOM_VOICES_STORAGE_KEY, JSON.stringify(customVoices));
    } catch (e) {
      console.error('Failed to persist custom voices:', e);
    }
  }, [customVoices]);

  useEffect(() => {
    try {
      localStorage.setItem(FAVORITE_VOICES_STORAGE_KEY, JSON.stringify(favoriteNames));
    } catch (e) {
      console.error('Failed to persist favorites:', e);
    }
  }, [favoriteNames]);

  useEffect(() => {
    let active = true;
    listVaultFiles()
      .then((records) => {
        if (active) setVaultFiles(records);
      })
      .finally(() => {
        if (active) setIsLoadingVault(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const vaultAudioFiles = useMemo(
    () => vaultFiles.filter((f) => f.kind === 'audio'),
    [vaultFiles]
  );
  const vaultScriptFiles = useMemo(
    () => vaultFiles.filter((f) => f.kind === 'script'),
    [vaultFiles]
  );

  const handleImportFiles = async (
    files: File[],
    requiredKind?: 'audio' | 'script'
  ) => {
    const result = await saveFilesToVault(files, requiredKind);
    if (result.saved.length > 0) {
      setVaultFiles((prev) => [...result.saved, ...prev]);
    }
    return result;
  };

  const handleDeleteVaultFile = async (id: string) => {
    await deleteVaultFile(id);
    setVaultFiles((prev) => prev.filter((f) => f.id !== id));
    setCreatorLaunchConfig((prev) =>
      prev.cloneFile?.id === id ? { ...prev, cloneFile: null } : prev
    );
  };

  const handleClearAllVaultFiles = async () => {
    await clearVaultFiles();
    setVaultFiles([]);
    setCreatorLaunchConfig((prev) => ({ ...prev, cloneFile: null }));
  };

  const handleSendAudioToClone = (record: ImportedFileRecord, consentConfirmed: boolean) => {
    stopVoiceSample();
    setPlayingVoice(null);
    setCreatorLaunchConfig({
      mode: 'clone',
      cloneFile: record,
      consentConfirmed,
    });
    setShowVoiceCreator(true);
  };

  const handleLoadScriptToStudio = (record: ImportedFileRecord) => {
    if (!record.textContent) return;
    stopVoiceSample();
    setPlayingVoice(null);
    setStudioImportedScript({
      id: record.id,
      name: record.name,
      content: record.textContent,
      version: Date.now(),
    });
    setWorkspaceTab('studio');
  };

  const allVoices = useMemo(() => [...customVoices, ...VOICE_DATA], [customVoices]);

  const uniqueGenders = useMemo(
    () => Array.from(new Set(allVoices.map((v) => v.analysis.gender))).sort(),
    [allVoices]
  );
  const uniquePitches = useMemo(
    () => Array.from(new Set(allVoices.map((v) => v.analysis.pitch))).sort(),
    [allVoices]
  );

  const filteredVoices = useMemo(() => {
    if (aiResult) {
      const recommended = aiResult.voiceNames
        .map((name) => allVoices.find((v) => v.name === name))
        .filter((v): v is Voice => !!v);
      return recommended.length > 0 ? recommended : allVoices;
    }

    return allVoices.filter((voice) => {
      if (filters.libraryScope === 'favorites' && !favoriteNames.includes(voice.name)) {
        return false;
      }
      if (filters.libraryScope === 'custom' && !voice.isCustom) {
        return false;
      }
      if (filters.libraryScope === 'gaming') {
        const traitsText = `${voice.characteristics.join(' ')} ${voice.analysis.characteristics.join(' ')} ${voice.styleCategory || ''}`.toLowerCase();
        const isGaming =
          voice.isGamingMode ||
          traitsText.includes('upbeat') ||
          traitsText.includes('energetic') ||
          traitsText.includes('lively') ||
          traitsText.includes('bright') ||
          traitsText.includes('gaming') ||
          traitsText.includes('funny') ||
          traitsText.includes('excitable');
        if (!isGaming) return false;
      }

      const matchGender = filters.gender === 'All' || voice.analysis.gender === filters.gender;
      const matchPitch = filters.pitch === 'All' || voice.analysis.pitch === filters.pitch;
      const matchLanguage =
        filters.language === 'All' ||
        (filters.language === 'Telugu' || filters.language === 'Tanglish'
          ? voice.language === filters.language || !voice.isCustom
          : voice.language === 'English' || !voice.isCustom);

      const searchLower = filters.search.toLowerCase();
      const matchSearch =
        filters.search === '' ||
        voice.name.toLowerCase().includes(searchLower) ||
        voice.characteristics.some((c) => c.toLowerCase().includes(searchLower)) ||
        voice.analysis.characteristics.some((c) => c.toLowerCase().includes(searchLower)) ||
        voice.analysis.gender.toLowerCase().startsWith(searchLower) ||
        voice.pitch.toLowerCase().includes(searchLower) ||
        (voice.language && voice.language.toLowerCase().includes(searchLower)) ||
        (voice.stylePrompt && voice.stylePrompt.toLowerCase().includes(searchLower));

      return matchGender && matchPitch && matchLanguage && matchSearch;
    });
  }, [filters, aiResult, allVoices, favoriteNames]);

  useEffect(() => {
    setActiveIndex(0);
  }, [filteredVoices.length]);

  const handlePlayToggle = (voiceName: string) => {
    unlockAudioContext();
    setPlayingVoice((current) => (current === voiceName ? null : voiceName));
  };

  const handleToggleFavorite = (voiceName: string) => {
    setFavoriteNames((prev) =>
      prev.includes(voiceName) ? prev.filter((n) => n !== voiceName) : [voiceName, ...prev]
    );
  };

  const handleSaveCustomVoice = (newVoice: Voice) => {
    setCustomVoices((prev) => [newVoice, ...prev]);
    setFavoriteNames((prev) => (prev.includes(newVoice.name) ? prev : [newVoice.name, ...prev]));
    setAiResult(null);
    setIsAiCardVisible(false);
    setStudioVoiceName(newVoice.name);
    setFilters({
      gender: 'All',
      pitch: 'All',
      language: 'All',
      libraryScope: 'all',
      search: '',
    });
    setActiveIndex(0);
    setShowVoiceCreator(false);
    setWorkspaceTab('library');
    setPlayingVoice(newVoice.name);
  };

  const handleSaveDesignedVoiceToMyLibrary = (newVoice: Voice) => {
    setCustomVoices((prev) => [newVoice, ...prev]);
    setFavoriteNames((prev) => (prev.includes(newVoice.name) ? prev : [newVoice.name, ...prev]));
    setStudioVoiceName(newVoice.name);
  };

  const handleDeleteCustomVoice = (voiceName: string) => {
    if (playingVoice === voiceName) setPlayingVoice(null);
    setCustomVoices((prev) => prev.filter((v) => v.name !== voiceName));
    setFavoriteNames((prev) => prev.filter((n) => n !== voiceName));
    setCompareSelection((prev) => prev.filter((name) => name !== voiceName));
  };

  const handleToggleCompare = (voiceName: string) => {
    setCompareSelection((prev) => {
      if (prev.includes(voiceName)) {
        return prev.filter((name) => name !== voiceName);
      }
      if (prev.length < 4) {
        return [...prev, voiceName];
      }
      return [...prev.slice(1), voiceName];
    });
  };

  const handleOpenCompare = (customContext?: {
    script?: string;
    language?: LanguageMode;
    accent?: TeluguAccent;
  }) => {
    stopVoiceSample();
    setPlayingVoice(null);
    if (allVoices.length < 2) return;

    let nextSel = compareSelection;
    if (nextSel.length === 0) {
      const first =
        allVoices.find((v) => v.name === studioVoiceName) ||
        filteredVoices[activeIndex] ||
        allVoices[0];
      const second = allVoices.find((v) => v.name !== first.name) || allVoices[1];
      nextSel = [first.name, second.name];
      setCompareSelection(nextSel);
    } else if (nextSel.length === 1) {
      const first = nextSel[0];
      const second = allVoices.find((v) => v.name !== first) || allVoices[0];
      nextSel = [first, second.name];
      setCompareSelection(nextSel);
    }

    setCompareLaunchContext(customContext || {});
    setShowCompareModal(true);
  };

  const handleOpenInStudio = (voiceName: string) => {
    stopVoiceSample();
    setPlayingVoice(null);
    setStudioVoiceName(voiceName);
    setWorkspaceTab('studio');
  };

  const clearAiResult = () => {
    setAiResult(null);
    setIsAiCardVisible(false);
    setFilters((prev) => ({ ...prev, search: '' }));
  };

  const isModalOpen =
    showVoiceFinder || showVoiceCreator || showCompareModal || Boolean(aiResult && isAiCardVisible);

  return (
    <div className="h-screen w-screen bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 font-sans overflow-hidden flex flex-col relative transition-colors duration-200">
      {/* Main App Content */}
      <div
        className="flex flex-col flex-1 overflow-hidden"
        aria-hidden={isModalOpen}
        // @ts-ignore
        inert={isModalOpen ? '' : undefined}
        style={isModalOpen ? { pointerEvents: 'none' } : {}}
      >
        <FilterBar
          workspaceTab={workspaceTab}
          onWorkspaceTabChange={(tab) => {
            stopVoiceSample();
            setPlayingVoice(null);
            setWorkspaceTab(tab);
          }}
          filters={filters}
          onFilterChange={setFilters}
          uniqueGenders={uniqueGenders}
          uniquePitches={uniquePitches}
          favoritesCount={favoriteNames.length}
          customCount={customVoices.length}
          importedFilesCount={vaultFiles.length}
          onOpenAiCasting={() => {
            stopVoiceSample();
            setPlayingVoice(null);
            setShowVoiceFinder(true);
          }}
          onOpenVoiceCreator={() => {
            stopVoiceSample();
            setPlayingVoice(null);
            setCreatorLaunchConfig({ mode: 'design', cloneFile: null, consentConfirmed: false });
            setShowVoiceCreator(true);
          }}
          onOpenCompare={() => handleOpenCompare()}
          compareCount={compareSelection.length}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          isDarkMode={isDarkMode}
          toggleTheme={() => setIsDarkMode((d) => !d)}
        />

        <main className="flex-1 relative flex flex-col overflow-hidden">
          {workspaceTab === 'library' ? (
            <>
              {filteredVoices.length > 0 ? (
                viewMode === 'carousel' ? (
                  <div className="w-full flex-1 flex items-center justify-center pb-14 md:pb-6 min-h-0">
                    <Carousel3D
                      voices={filteredVoices}
                      activeIndex={activeIndex}
                      onChange={setActiveIndex}
                      playingVoice={playingVoice}
                      favoriteNames={favoriteNames}
                      onPlayToggle={handlePlayToggle}
                      onToggleFavorite={handleToggleFavorite}
                      onOpenInStudio={handleOpenInStudio}
                      onDeleteCustomVoice={handleDeleteCustomVoice}
                      compareSelection={compareSelection}
                      onToggleCompare={handleToggleCompare}
                      disabled={isModalOpen}
                    />
                  </div>
                ) : (
                  <div className="flex-1 overflow-hidden">
                    <GridView
                      voices={filteredVoices}
                      playingVoice={playingVoice}
                      favoriteNames={favoriteNames}
                      onPlayToggle={handlePlayToggle}
                      onToggleFavorite={handleToggleFavorite}
                      onOpenInStudio={handleOpenInStudio}
                      onDeleteCustomVoice={handleDeleteCustomVoice}
                      compareSelection={compareSelection}
                      onToggleCompare={handleToggleCompare}
                    />
                  </div>
                )
              ) : (
                <div className="w-full h-full flex items-center justify-center pb-24 px-4">
                  <div className="text-center max-w-md space-y-4">
                    <div className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800">
                      <Info size={26} className="text-zinc-400" />
                    </div>
                    <h3 className="text-lg font-bold text-zinc-900 dark:text-white">
                      {filters.libraryScope === 'favorites'
                        ? 'My Voice Library is empty'
                        : 'No matching voices'}
                    </h3>
                    <p className="text-sm text-zinc-500 dark:text-zinc-400">
                      {filters.libraryScope === 'favorites'
                        ? 'Tap the heart icon on any voice card to save it to your favorites.'
                        : 'Adjust your filters or create a brand-new AI voice.'}
                    </p>
                    <div className="flex items-center justify-center gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          setFilters({
                            gender: 'All',
                            pitch: 'All',
                            language: 'All',
                            libraryScope: 'all',
                            search: '',
                          })
                        }
                        className="min-h-[42px] px-4 py-2 bg-zinc-200 dark:bg-zinc-800 text-zinc-900 dark:text-white rounded-xl text-xs font-semibold"
                      >
                        Show All Voices
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setCreatorLaunchConfig({
                            mode: 'design',
                            cloneFile: null,
                            consentConfirmed: false,
                          });
                          setShowVoiceCreator(true);
                        }}
                        className="min-h-[42px] px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-semibold"
                      >
                        Create Voice
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Floating Compare Selection Tray */}
              {compareSelection.length > 0 && !isModalOpen && (
                <div className="absolute bottom-16 md:bottom-5 left-1/2 -translate-x-1/2 z-40 px-3 w-full max-w-2xl pointer-events-none">
                  <div className="pointer-events-auto bg-white/95 dark:bg-zinc-900/95 backdrop-blur-xl border border-zinc-200 dark:border-zinc-700 shadow-2xl rounded-2xl px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2.5">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {compareSelection.map((name, i) => (
                        <span
                          key={name}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-indigo-600/15 text-indigo-600 dark:text-indigo-300 border border-indigo-500/30 text-xs font-semibold"
                        >
                          <span>
                            {['A', 'B', 'C', 'D'][i]}: {name}
                          </span>
                          <button
                            type="button"
                            onClick={() => handleToggleCompare(name)}
                            className="hover:text-white"
                            aria-label={`Remove ${name} from compare`}
                          >
                            <X size={12} />
                          </button>
                        </span>
                      ))}
                      {compareSelection.length === 1 && (
                        <span className="text-xs text-zinc-400 italic">Select 1–3 more voices</span>
                      )}
                    </div>

                    <div className="flex items-center gap-2 ml-auto">
                      <button
                        type="button"
                        onClick={() => setCompareSelection([])}
                        className="px-2.5 py-1.5 rounded-lg text-xs font-medium text-zinc-500 hover:text-zinc-900 dark:hover:text-white"
                      >
                        Clear
                      </button>
                      <button
                        type="button"
                        onClick={() => handleOpenCompare()}
                        disabled={compareSelection.length < 2}
                        className="min-h-[36px] flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-xs font-semibold"
                      >
                        <GitCompare size={13} />
                        <span>Compare ({compareSelection.length})</span>
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </>
          ) : workspaceTab === 'design' ? (
            <VoiceDesignStudioView
              baseVoices={VOICE_DATA}
              allVoices={allVoices}
              favoriteNames={favoriteNames}
              existingNames={allVoices.map((v) => v.name)}
              onSaveToMyLibrary={handleSaveDesignedVoiceToMyLibrary}
              onToggleFavorite={handleToggleFavorite}
              onOpenInAudioStudio={handleOpenInStudio}
            />
          ) : workspaceTab === 'conversation' ? (
            <BatchConversationStudioView voices={allVoices} />
          ) : workspaceTab === 'files' ? (
            <FileManagerView
              files={vaultFiles}
              isLoadingVault={isLoadingVault}
              onImportFiles={handleImportFiles}
              onDeleteFile={handleDeleteVaultFile}
              onClearAllFiles={handleClearAllVaultFiles}
              onSendAudioToClone={handleSendAudioToClone}
              onLoadScriptToStudio={handleLoadScriptToStudio}
            />
          ) : (
            <AudioStudioView
              voices={allVoices}
              favoriteNames={favoriteNames}
              selectedVoiceName={studioVoiceName}
              onSelectVoice={setStudioVoiceName}
              onToggleFavorite={handleToggleFavorite}
              gamingModeDefault={workspaceTab === 'gaming'}
              onOpenCompareWithScript={(script, language, accent) =>
                handleOpenCompare({ script, language, accent })
              }
              importedScript={studioImportedScript}
              vaultScripts={vaultScriptFiles}
              onImportScriptFiles={handleImportFiles}
              onOpenFileManager={() => setWorkspaceTab('files')}
            />
          )}
        </main>

        {/* Mobile & Tablet Bottom Navigation Bar (Android Responsive Ergonomics) */}
        <nav
          className="lg:hidden fixed bottom-0 left-0 right-0 z-40 h-14 bg-white/95 dark:bg-zinc-950/95 backdrop-blur-md border-t border-zinc-200 dark:border-zinc-800 grid grid-cols-6 items-center"
          aria-label="Mobile navigation"
        >
          <button
            type="button"
            onClick={() => {
              setWorkspaceTab('library');
              setFilters((f) => ({ ...f, libraryScope: 'all' }));
            }}
            className={`min-h-[44px] flex flex-col items-center justify-center gap-0.5 text-[10px] font-semibold ${
              workspaceTab === 'library'
                ? 'text-indigo-500'
                : 'text-zinc-500 dark:text-zinc-400'
            }`}
          >
            <Library size={18} />
            <span>Library</span>
          </button>

          <button
            type="button"
            onClick={() => setWorkspaceTab('design')}
            className={`min-h-[44px] flex flex-col items-center justify-center gap-0.5 text-[10px] font-semibold ${
              workspaceTab === 'design' ? 'text-indigo-500' : 'text-zinc-500 dark:text-zinc-400'
            }`}
          >
            <Wand2 size={18} />
            <span>Design</span>
          </button>

          <button
            type="button"
            onClick={() => setWorkspaceTab('conversation')}
            className={`min-h-[44px] flex flex-col items-center justify-center gap-0.5 text-[10px] font-semibold ${
              workspaceTab === 'conversation' ? 'text-indigo-500' : 'text-zinc-500 dark:text-zinc-400'
            }`}
          >
            <Users size={18} />
            <span>Convo</span>
          </button>

          <button
            type="button"
            onClick={() => setWorkspaceTab('studio')}
            className={`min-h-[44px] flex flex-col items-center justify-center gap-0.5 text-[10px] font-semibold ${
              workspaceTab === 'studio' ? 'text-indigo-500' : 'text-zinc-500 dark:text-zinc-400'
            }`}
          >
            <AudioLines size={18} />
            <span>Studio</span>
          </button>

          <button
            type="button"
            onClick={() => setWorkspaceTab('gaming')}
            className={`min-h-[44px] flex flex-col items-center justify-center gap-0.5 text-[10px] font-semibold ${
              workspaceTab === 'gaming' ? 'text-emerald-500' : 'text-zinc-500 dark:text-zinc-400'
            }`}
          >
            <Gamepad2 size={18} />
            <span>Gaming</span>
          </button>

          <button
            type="button"
            onClick={() => setWorkspaceTab('files')}
            className={`min-h-[44px] flex flex-col items-center justify-center gap-0.5 text-[10px] font-semibold ${
              workspaceTab === 'files' ? 'text-teal-500' : 'text-zinc-500 dark:text-zinc-400'
            }`}
          >
            <FolderOpen size={18} />
            <span>Files</span>
          </button>
        </nav>
      </div>

      {/* Modals */}
      {showVoiceFinder && (
        <VoiceFinder
          voices={allVoices}
          onRecommendation={(rec) => {
            if (rec) {
              setAiResult(rec);
              setIsAiCardVisible(true);
              setWorkspaceTab('library');
              setFilters((prev) => ({ ...prev, search: '', libraryScope: 'all' }));
            }
            setShowVoiceFinder(false);
          }}
          onClose={() => setShowVoiceFinder(false)}
        />
      )}

      {showVoiceCreator && (
        <VoiceCreatorModal
          baseVoices={VOICE_DATA}
          existingNames={allVoices.map((v) => v.name)}
          onSaveVoice={handleSaveCustomVoice}
          onClose={() => {
            setShowVoiceCreator(false);
            setCreatorLaunchConfig({ mode: 'design', cloneFile: null, consentConfirmed: false });
          }}
          initialMode={creatorLaunchConfig.mode}
          initialCloneFile={creatorLaunchConfig.cloneFile}
          initialCloneConsent={creatorLaunchConfig.consentConfirmed}
          vaultAudioFiles={vaultAudioFiles}
          onImportAudioFiles={handleImportFiles}
          onDeleteVaultFile={handleDeleteVaultFile}
        />
      )}

      {showCompareModal && allVoices.length >= 2 && (
        <CompareVoicesModal
          allVoices={allVoices}
          initialVoiceNames={
            compareSelection.length >= 2
              ? compareSelection
              : allVoices.slice(0, 2).map((v) => v.name)
          }
          initialScript={compareLaunchContext.script}
          initialLanguage={compareLaunchContext.language}
          initialAccent={compareLaunchContext.accent}
          onUpdateSelection={(names) => setCompareSelection(names)}
          onClose={() => setShowCompareModal(false)}
        />
      )}

      {aiResult && isAiCardVisible && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-fade-in"
          role="dialog"
          aria-modal="true"
          aria-labelledby="ai-result-title"
        >
          <div className="absolute inset-0" onClick={clearAiResult}></div>
          <div className="relative w-full max-w-5xl animate-slide-up max-h-[90vh] overflow-hidden rounded-2xl">
            <AiResultCard result={aiResult} voices={filteredVoices} onClose={clearAiResult} />
          </div>
        </div>
      )}
    </div>
  );
};

export default App;