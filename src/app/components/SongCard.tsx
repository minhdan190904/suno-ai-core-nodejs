'use client';

import { useState, useRef } from 'react';

type SongStatus = 'submitted' | 'queued' | 'streaming' | 'complete' | 'error';

export interface Song {
  id: string;
  title?: string;
  status: SongStatus;
  audio_url?: string;
  image_url?: string;
  lyric?: string;
  tags?: string;
  prompt?: string;
  model_name?: string;
  duration?: number;
}

function StatusBadge({ status }: { status: SongStatus }) {
  const map: Record<SongStatus, { label: string; color: string; dot: string }> = {
    submitted: { label: 'Đã gửi', color: 'bg-blue-500/20 text-blue-300 border-blue-500/30', dot: 'bg-blue-400 animate-pulse' },
    queued:    { label: 'Đang chờ', color: 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30', dot: 'bg-yellow-400 animate-pulse' },
    streaming: { label: 'Đang tạo...', color: 'bg-purple-500/20 text-purple-300 border-purple-500/30', dot: 'bg-purple-400 animate-ping' },
    complete:  { label: 'Hoàn thành', color: 'bg-green-500/20 text-green-300 border-green-500/30', dot: 'bg-green-400' },
    error:     { label: 'Lỗi', color: 'bg-red-500/20 text-red-300 border-red-500/30', dot: 'bg-red-400' },
  };
  const s = map[status] ?? map.submitted;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${s.color}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}

function AudioPlayer({ url }: { url: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);

  const toggle = () => {
    if (!audioRef.current) return;
    if (playing) { audioRef.current.pause(); setPlaying(false); }
    else { audioRef.current.play(); setPlaying(true); }
  };

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  return (
    <div className="flex items-center gap-3 bg-white/5 rounded-xl px-3 py-2.5 border border-white/10">
      <audio
        ref={audioRef}
        src={url}
        onTimeUpdate={() => setProgress(audioRef.current?.currentTime ?? 0)}
        onLoadedMetadata={() => setDuration(audioRef.current?.duration ?? 0)}
        onEnded={() => setPlaying(false)}
      />
      {/* Play/Pause */}
      <button
        onClick={toggle}
        className="w-9 h-9 rounded-full bg-indigo-500 hover:bg-indigo-400 flex items-center justify-center flex-shrink-0 transition-all duration-200 hover:scale-105 shadow-lg shadow-indigo-500/30"
      >
        {playing ? (
          <svg className="w-3.5 h-3.5 text-white" fill="currentColor" viewBox="0 0 24 24">
            <rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>
          </svg>
        ) : (
          <svg className="w-3.5 h-3.5 text-white ml-0.5" fill="currentColor" viewBox="0 0 24 24">
            <path d="M8 5v14l11-7z"/>
          </svg>
        )}
      </button>
      {/* Progress bar */}
      <div className="flex-1 flex flex-col gap-1">
        <input
          type="range" min={0} max={duration || 1} value={progress} step={0.1}
          onChange={e => { if (audioRef.current) { audioRef.current.currentTime = Number(e.target.value); setProgress(Number(e.target.value)); } }}
          className="w-full h-1 bg-white/20 rounded-full appearance-none cursor-pointer accent-indigo-400"
        />
      </div>
      <span className="text-xs text-white/40 font-mono flex-shrink-0">{fmt(progress)} / {fmt(duration)}</span>
      {/* Download */}
      <a
        href={url} download
        className="w-7 h-7 rounded-lg bg-white/10 hover:bg-white/20 flex items-center justify-center transition-colors flex-shrink-0"
        title="Tải xuống"
      >
        <svg className="w-3.5 h-3.5 text-white/60" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
        </svg>
      </a>
    </div>
  );
}

export default function SongCard({ song }: { song: Song }) {
  const [lyricsOpen, setLyricsOpen] = useState(false);
  const isDone = song.status === 'complete' || song.status === 'streaming';

  return (
    <div className={`group relative rounded-2xl border transition-all duration-300 overflow-hidden
      ${isDone
        ? 'bg-white/5 border-white/10 hover:border-indigo-500/40 hover:bg-white/[0.07]'
        : 'bg-white/[0.03] border-white/5'
      }`}
    >
      <div className="flex gap-4 p-4">
        {/* Thumbnail */}
        <div className="w-20 h-20 flex-shrink-0 rounded-xl overflow-hidden bg-gradient-to-br from-indigo-600 to-purple-700 flex items-center justify-center">
          {song.image_url ? (
            <img
              src={song.image_url}
              alt={song.title}
              className="w-full h-full object-cover"
              crossOrigin="anonymous"
              loading="lazy"
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
            />
          ) : (
            <svg className="w-8 h-8 text-white/30" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
            </svg>
          )}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2 mb-2">
            <div>
              <h3 className="font-semibold text-white/90 text-sm leading-tight truncate">
                {song.title || (song.prompt ? `"${song.prompt.slice(0, 40)}..."` : 'Đang tạo...')}
              </h3>
              {song.tags && (
                <p className="text-xs text-indigo-300/70 mt-0.5 truncate">{song.tags}</p>
              )}
            </div>
            <StatusBadge status={song.status} />
          </div>

          {/* Generating animation */}
          {!isDone && (
            <div className="flex items-center gap-1.5 mt-3">
              {[...Array(12)].map((_, i) => (
                <div
                  key={i}
                  className="w-1 rounded-full bg-indigo-400/60 animate-bounce"
                  style={{ height: `${8 + Math.random() * 16}px`, animationDelay: `${i * 0.08}s`, animationDuration: '0.8s' }}
                />
              ))}
              <span className="text-xs text-white/30 ml-2">AI đang sáng tác...</span>
            </div>
          )}
        </div>
      </div>

      {/* Audio Player */}
      {isDone && song.audio_url && (
        <div className="px-4 pb-3">
          <AudioPlayer url={song.audio_url} />
        </div>
      )}

      {/* Lyrics toggle */}
      {isDone && song.lyric && (
        <div className="px-4 pb-4">
          <button
            onClick={() => setLyricsOpen(!lyricsOpen)}
            className="flex items-center gap-1.5 text-xs text-white/40 hover:text-white/70 transition-colors"
          >
            <svg className={`w-3 h-3 transition-transform ${lyricsOpen ? 'rotate-90' : ''}`} fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z"/>
            </svg>
            {lyricsOpen ? 'Ẩn lời bài hát' : 'Xem lời bài hát'}
          </button>
          {lyricsOpen && (
            <pre className="mt-2 text-xs text-white/50 leading-relaxed whitespace-pre-wrap font-sans bg-white/5 rounded-lg p-3 border border-white/5 max-h-48 overflow-y-auto">
              {song.lyric}
            </pre>
          )}
        </div>
      )}

      {/* Subtle shimmer when generating */}
      {!isDone && (
        <div className="absolute inset-0 pointer-events-none overflow-hidden rounded-2xl">
          <div className="absolute inset-0 -translate-x-full animate-[shimmer_2s_infinite] bg-gradient-to-r from-transparent via-white/5 to-transparent" />
        </div>
      )}
    </div>
  );
}
