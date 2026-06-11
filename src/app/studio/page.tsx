'use client';

import { useState, useEffect, useCallback } from 'react';
import SongCard, { Song } from '../components/SongCard';

type Mode = 'simple' | 'custom';

const GENRES = [
  'Pop', 'Rock', 'Hip Hop', 'R&B', 'Jazz', 'Classical', 'Electronic',
  'Lo-fi', 'Acoustic', 'Metal', 'Folk', 'Indie', 'Dance', 'Ballad',
  'Rap', 'Chill', 'Ambient', 'Latin', 'Blues', 'Country',
];

export default function StudioPage() {
  const [mode, setMode] = useState<Mode>('simple');
  const [prompt, setPrompt] = useState('');
  const [lyrics, setLyrics] = useState('');
  const [tags, setTags] = useState('');
  const [title, setTitle] = useState('');
  const [instrumental, setInstrumental] = useState(false);
  const [songs, setSongs] = useState<Song[]>([]);
  const [loading, setLoading] = useState(false);
  const [credits, setCredits] = useState<number | null>(null);
  const [pollingIds, setPollingIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const [lyricsPrompt, setLyricsPrompt] = useState('');
  const [lyricsLoading, setLyricsLoading] = useState(false);
  const [showLyricsAI, setShowLyricsAI] = useState(false);

  // Fetch credits on mount
  useEffect(() => {
    fetch('/api/get_limit')
      .then(r => r.json())
      .then(d => setCredits(d.credits_left))
      .catch(() => {});
  }, []);

  // Polling for pending songs
  useEffect(() => {
    if (pollingIds.size === 0) return;
    const interval = setInterval(async () => {
      try {
        const ids = Array.from(pollingIds).join(',');
        const res = await fetch(`/api/get?ids=${ids}`);
        const data: Song[] = await res.json();

        setSongs(prev => {
          const map = new Map(prev.map(s => [s.id, s]));
          data.forEach(s => map.set(s.id, { ...map.get(s.id), ...s }));
          return Array.from(map.values());
        });

        setPollingIds(prev => {
          const next = new Set(prev);
          data.forEach(s => {
            if (s.status === 'complete' || s.status === 'streaming' || s.status === 'error') {
              next.delete(s.id);
            }
          });
          return next;
        });

        // Update credits if any song completed
        if (data.some(s => s.status === 'complete' || s.status === 'streaming')) {
          fetch('/api/get_limit').then(r => r.json()).then(d => setCredits(d.credits_left)).catch(() => {});
        }
      } catch {}
    }, 4000);
    return () => clearInterval(interval);
  }, [pollingIds]);

  const handleGenerate = useCallback(async () => {
    setError('');
    if (mode === 'simple' && !prompt.trim()) { setError('Vui lòng nhập mô tả bài hát!'); return; }
    if (mode === 'custom' && !lyrics.trim()) { setError('Vui lòng nhập lời bài hát!'); return; }

    setLoading(true);
    try {
      const endpoint = mode === 'simple' ? '/api/generate' : '/api/custom_generate';
      const body = mode === 'simple'
        ? { prompt: prompt.trim(), make_instrumental: instrumental, wait_audio: false }
        : { prompt: lyrics.trim(), tags: tags.trim(), title: title.trim(), make_instrumental: instrumental, wait_audio: false };

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        // Try to parse error detail from API
        let errMsg = `Lỗi HTTP ${res.status}`;
        try {
          const errData = await res.json();
          if (errData?.error) errMsg = errData.error;
          else if (errData?.detail) errMsg = errData.detail;
        } catch {}

        if (res.status === 403) {
          setError(`⛔ Tài khoản không có quyền dùng model này. Thử đổi model hoặc nâng cấp plan. (${errMsg})`);
        } else if (res.status === 402) {
          setError('💳 Hết credits! Vui lòng nâng cấp plan Suno.');
        } else if (res.status === 503) {
          setError('🌐 Không kết nối được Suno API. Kiểm tra mạng và SUNO_COOKIE!');
        } else {
          setError(`❌ ${errMsg}`);
        }
        return;
      }
      const data: Song[] = await res.json();

      setSongs(prev => [...data, ...prev]);
      setPollingIds(prev => {
        const next = new Set(prev);
        data.forEach(s => next.add(s.id));
        return next;
      });
    } catch (e: any) {
      setError('❌ Có lỗi xảy ra khi kết nối server. Vui lòng thử lại!');
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [mode, prompt, lyrics, tags, title, instrumental]);

  const handleGenerateLyrics = useCallback(async () => {
    if (!lyricsPrompt.trim()) return;
    setLyricsLoading(true);
    try {
      const res = await fetch('/api/generate_lyrics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: lyricsPrompt.trim() }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const text = data?.text || data?.lyrics || JSON.stringify(data);
      setLyrics(text);
      setShowLyricsAI(false);
    } catch (e: any) {
      setError('❌ Không tạo được lyrics: ' + e.message);
    } finally {
      setLyricsLoading(false);
    }
  }, [lyricsPrompt]);

  const pendingCount = pollingIds.size;

  return (
    <div className="min-h-screen w-full bg-gradient-to-br from-gray-950 via-indigo-950 to-purple-950">
      {/* Decorative blobs */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -right-40 w-96 h-96 bg-indigo-600/20 rounded-full blur-3xl" />
        <div className="absolute top-1/2 -left-40 w-80 h-80 bg-purple-600/15 rounded-full blur-3xl" />
        <div className="absolute -bottom-20 right-1/4 w-72 h-72 bg-pink-600/10 rounded-full blur-3xl" />
      </div>

      <div className="relative z-10 max-w-3xl mx-auto px-4 py-10">

        {/* Header */}
        <div className="mb-10 text-center">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-indigo-300 text-xs font-medium mb-4">
            <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
            API đang chạy · localhost:3000
          </div>
          <h1 className="text-5xl font-bold text-white mb-3 tracking-tight">
            🎵 Suno <span className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 to-pink-400">Studio</span>
          </h1>
          <p className="text-white/50 text-lg">Tạo nhạc AI trong vài giây với Suno AI</p>

          {/* Credits */}
          {credits !== null && (
            <div className="inline-flex items-center gap-2 mt-4 px-4 py-2 rounded-xl bg-white/5 border border-white/10 text-sm">
              <svg className="w-4 h-4 text-yellow-400" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 21 12 17.77 5.82 21 7 14.14 2 9.27l6.91-1.01L12 2z"/>
              </svg>
              <span className="text-white/60">Credits còn lại:</span>
              <span className="font-bold text-yellow-400">{credits}</span>
              <span className="text-white/30">/ tháng</span>
            </div>
          )}
        </div>

        {/* Form card */}
        <div className="rounded-2xl bg-white/[0.04] border border-white/10 backdrop-blur-sm p-6 mb-8 shadow-2xl">

          {/* Mode toggle */}
          <div className="flex bg-white/5 rounded-xl p-1 mb-6 border border-white/10">
            {(['simple', 'custom'] as Mode[]).map(m => (
              <button
                key={m}
                onClick={() => { setMode(m); setError(''); }}
                className={`flex-1 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 flex items-center justify-center gap-2
                  ${mode === m
                    ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/30'
                    : 'text-white/40 hover:text-white/70'
                  }`}
              >
                {m === 'simple' ? (
                  <><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>Simple Mode</>
                ) : (
                  <><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>Custom Mode</>
                )}
              </button>
            ))}
          </div>

          {/* Simple Mode */}
          {mode === 'simple' && (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-white/70 mb-2">
                  Mô tả bài hát bạn muốn tạo <span className="text-indigo-400">*</span>
                </label>
                <textarea
                  value={prompt}
                  onChange={e => setPrompt(e.target.value)}
                  placeholder="Ví dụ: Một bài ballad nhẹ nhàng về mùa thu Hà Nội, giọng nữ ngọt ngào, tiếng Việt..."
                  rows={4}
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-white/25 focus:outline-none focus:border-indigo-500/50 focus:bg-white/[0.07] resize-none transition-all duration-200 text-sm"
                />
                <p className="text-xs text-white/30 mt-1.5">💡 Mô tả càng chi tiết (thể loại, cảm xúc, nhịp độ) thì kết quả càng tốt</p>
              </div>
            </div>
          )}

          {/* Custom Mode */}
          {mode === 'custom' && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-white/70 mb-2">Tiêu đề bài hát</label>
                  <input
                    type="text"
                    value={title}
                    onChange={e => setTitle(e.target.value)}
                    placeholder="Tên bài hát..."
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-white/25 focus:outline-none focus:border-indigo-500/50 focus:bg-white/[0.07] transition-all duration-200 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-white/70 mb-2">Thể loại / Tags</label>
                  <input
                    type="text"
                    value={tags}
                    onChange={e => setTags(e.target.value)}
                    placeholder="pop, acoustic, sad..."
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-white/25 focus:outline-none focus:border-indigo-500/50 focus:bg-white/[0.07] transition-all duration-200 text-sm"
                  />
                </div>
              </div>

              {/* Genre quick select */}
              <div>
                <p className="text-xs text-white/40 mb-2">Chọn nhanh thể loại:</p>
                <div className="flex flex-wrap gap-2">
                  {GENRES.map(g => (
                    <button
                      key={g}
                      onClick={() => setTags(prev => {
                        const arr = prev.split(',').map(s => s.trim()).filter(Boolean);
                        return arr.includes(g) ? arr.filter(s => s !== g).join(', ') : [...arr, g].join(', ');
                      })}
                      className={`px-3 py-1 rounded-full text-xs border transition-all duration-150
                        ${tags.includes(g)
                          ? 'bg-indigo-500/30 border-indigo-400/50 text-indigo-300'
                          : 'bg-white/5 border-white/10 text-white/40 hover:border-white/20 hover:text-white/60'
                        }`}
                    >
                      {g}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                {/* Lyrics label + AI button */}
                <div className="flex items-center justify-between mb-2">
                  <label className="text-sm font-medium text-white/70">
                    Lời bài hát <span className="text-indigo-400">*</span>
                  </label>
                  <button
                    onClick={() => setShowLyricsAI(!showLyricsAI)}
                    className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-purple-500/15 border border-purple-500/30 text-purple-300 text-xs font-medium hover:bg-purple-500/25 transition-all duration-150"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z"/>
                    </svg>
                    ✨ AI viết lyrics
                  </button>
                </div>

                {/* AI Lyrics generator panel */}
                {showLyricsAI && (
                  <div className="mb-3 p-3 rounded-xl bg-purple-500/10 border border-purple-500/20">
                    <p className="text-xs text-purple-300/70 mb-2">Mô tả nội dung lyrics bạn muốn AI viết:</p>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={lyricsPrompt}
                        onChange={e => setLyricsPrompt(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && handleGenerateLyrics()}
                        placeholder="Vd: bài hát buồn về tình yêu xa cách, tiếng Việt..."
                        className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white placeholder-white/25 focus:outline-none focus:border-purple-500/50 text-xs"
                      />
                      <button
                        onClick={handleGenerateLyrics}
                        disabled={lyricsLoading || !lyricsPrompt.trim()}
                        className="px-4 py-2 rounded-lg bg-purple-600 hover:bg-purple-500 disabled:bg-purple-600/40 disabled:cursor-not-allowed text-white text-xs font-medium transition-all flex items-center gap-1.5 flex-shrink-0"
                      >
                        {lyricsLoading ? (
                          <><svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>Đang viết...</>
                        ) : (
                          <>✨ Tạo</>
                        )}
                      </button>
                    </div>
                    <p className="text-xs text-purple-300/40 mt-1.5">💡 Miễn phí, không tốn credits nhạc</p>
                  </div>
                )}

                <textarea
                  value={lyrics}
                  onChange={e => setLyrics(e.target.value)}
                  placeholder={`[Verse 1]\nViết lời verse đầu tiên của bạn ở đây...\n\n[Chorus]\nĐiệp khúc của bài hát...\n\n[Verse 2]\n...`}
                  rows={8}
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-white/25 focus:outline-none focus:border-indigo-500/50 focus:bg-white/[0.07] resize-none transition-all duration-200 text-sm font-mono"
                />
              </div>
            </div>
          )}

          {/* Instrumental toggle (shared) */}
          <div className="flex items-center justify-between mt-5 pt-5 border-t border-white/10">
            <div>
              <p className="text-sm font-medium text-white/70">Nhạc không lời (Instrumental)</p>
              <p className="text-xs text-white/30 mt-0.5">Tạo nhạc nền, không có giọng hát</p>
            </div>
            <button
              onClick={() => setInstrumental(!instrumental)}
              className={`relative w-11 h-6 rounded-full transition-all duration-200 flex-shrink-0 ${instrumental ? 'bg-indigo-500' : 'bg-white/10'}`}
            >
              <span className={`absolute top-1 w-4 h-4 rounded-full bg-white shadow transition-all duration-200 ${instrumental ? 'left-6' : 'left-1'}`} />
            </button>
          </div>

          {/* Error */}
          {error && (
            <div className="mt-4 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-300 text-sm flex items-center gap-2">
              <svg className="w-4 h-4 flex-shrink-0" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
              {error}
            </div>
          )}

          {/* Generate button */}
          <button
            onClick={handleGenerate}
            disabled={loading}
            className={`w-full mt-6 py-4 rounded-xl font-semibold text-base flex items-center justify-center gap-3 transition-all duration-200
              ${loading
                ? 'bg-indigo-600/50 text-white/50 cursor-not-allowed'
                : 'bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white shadow-xl shadow-indigo-500/25 hover:shadow-indigo-500/40 hover:scale-[1.01] active:scale-100'
              }`}
          >
            {loading ? (
              <>
                <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                </svg>
                Đang gửi yêu cầu...
              </>
            ) : (
              <>
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3"/>
                </svg>
                ✨ Tạo bài hát
                <span className="text-xs font-normal text-white/50 ml-1">~1–2 phút</span>
              </>
            )}
          </button>
        </div>

        {/* Song list */}
        {songs.length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-white/80 flex items-center gap-2">
                🎶 Bài hát đã tạo
                <span className="text-sm font-normal text-white/30">({songs.length})</span>
              </h2>
              {pendingCount > 0 && (
                <div className="flex items-center gap-2 text-xs text-purple-300 bg-purple-500/10 border border-purple-500/20 px-3 py-1.5 rounded-full">
                  <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                  </svg>
                  {pendingCount} bài đang tạo...
                </div>
              )}
            </div>
            <div className="space-y-3">
              {songs.map(song => (
                <SongCard key={song.id} song={song} />
              ))}
            </div>
          </div>
        )}

        {/* Empty state */}
        {songs.length === 0 && (
          <div className="text-center py-20 text-white/20">
            <div className="text-6xl mb-4">🎼</div>
            <p className="text-lg">Chưa có bài hát nào</p>
            <p className="text-sm mt-1">Nhập mô tả và nhấn &ldquo;Tạo bài hát&rdquo; để bắt đầu!</p>
          </div>
        )}
      </div>

      <style jsx global>{`
        @keyframes shimmer {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(200%); }
        }
        input[type=range]::-webkit-slider-thumb {
          -webkit-appearance: none;
          width: 12px; height: 12px;
          border-radius: 50%;
          background: #818cf8;
          cursor: pointer;
        }
        input[type=range]::-webkit-slider-runnable-track {
          background: rgba(255,255,255,0.15);
          border-radius: 9999px;
          height: 4px;
        }
      `}</style>
    </div>
  );
}
