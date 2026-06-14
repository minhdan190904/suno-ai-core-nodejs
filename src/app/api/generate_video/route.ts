import { NextResponse } from 'next/server';
import { exec } from 'child_process';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

const execAsync = promisify(exec);

function formatAssTime(seconds: number) {
    const d = new Date(seconds * 1000);
    const h = String(d.getUTCHours());
    const m = String(d.getUTCMinutes()).padStart(2, '0');
    const s = String(d.getUTCSeconds()).padStart(2, '0');
    const cs = String(Math.floor(d.getUTCMilliseconds() / 10)).padStart(2, '0');
    return `${h}:${m}:${s}.${cs}`;
}

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const { song_id, image_url } = body;
        
        if (!song_id) {
            return NextResponse.json({ error: 'Missing song_id' }, { status: 400 });
        }

        const baseUrl = 'http://localhost:3000';

        // 1. Fetch Audio Info
        const songRes = await fetch(`${baseUrl}/api/get?ids=${song_id}`);
        const songData = await songRes.json();
        if (!songData || songData.length === 0 || !songData[0].audio_url) {
            return NextResponse.json({ error: 'Could not find audio_url' }, { status: 400 });
        }
        
        const audioUrl = songData[0].audio_url;
        const cleanTitle = (songData[0].title || "Suno Generated Song").replace(/\n/g, ' ').replace(/,/g, '');
        const cleanArtist = (songData[0].display_name || "AiMusic Studio").replace(/\n/g, ' ').replace(/,/g, '');

        // 2. Fetch Aligned Lyrics
        const lyricsRes = await fetch(`${baseUrl}/api/get_aligned_lyrics?song_id=${song_id}`);
        const lyricsData = await lyricsRes.json();

        // 3. Get actual audio duration via ffprobe
        let duration = 120;
        try {
            const { stdout } = await execAsync(`ffprobe -i "${audioUrl}" -show_entries format=duration -v quiet -of csv="p=0"`);
            const parsed = parseFloat(stdout.trim());
            if (!isNaN(parsed)) duration = parsed;
        } catch (e) {
            console.log("[FFprobe] Warning: Could not fetch duration, using 120s fallback.");
        }

        // 4. Generate ASS Subtitle File
        let assContent = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,70,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,2,0,5,50,50,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

        let processedLyrics = [];
        if (Array.isArray(lyricsData)) {
            for (const item of lyricsData) {
                if (item.word.includes('\n')) {
                    let parts = item.word.split(/(\n)/);
                    let currentPart = "";
                    for (let p of parts) {
                        if (p === '\n') {
                            processedLyrics.push({ ...item, word: currentPart + '\n' });
                            currentPart = "";
                        } else {
                            currentPart += p;
                        }
                    }
                    if (currentPart.length > 0) {
                        processedLyrics.push({ ...item, word: currentPart });
                    }
                } else {
                    processedLyrics.push(item);
                }
            }
        }

        let lines = [];
        let currentLine = [];
        for (const item of processedLyrics) {
            currentLine.push(item);
            if (item.word.includes('\n')) {
                lines.push(currentLine);
                currentLine = [];
            }
        }
        if (currentLine.length > 0) lines.push(currentLine);

        if (lines.length === 0) {
            assContent += `Dialogue: 0,0:00:00.00,9:59:59.99,Default,,0,0,0,,(Instrumental / No Lyrics)\n`;
        } else {
            const linesPerPage = 2;
            for (let i = 0; i < lines.length; i += linesPerPage) {
                const pageLines = lines.slice(i, i + linesPerPage);
                
                let start_s = Infinity;
                let end_s = 0;
                let text = "";
                
                for (let j = 0; j < pageLines.length; j++) {
                    const line = pageLines[j];
                    for (const w of line) {
                        const ws = Number(w.start_s) || 0;
                        const we = Number(w.end_s) || ws + 0.1;
                        if (ws < start_s) start_s = ws;
                        if (we > end_s) end_s = we;
                        
                        let cleanWord = w.word.replace(/\\n/g, '').replace(/\\{/g, '(').replace(/\\}/g, ')').trim();
                        if (cleanWord) {
                            text += cleanWord + " ";
                        }
                    }
                    if (j < pageLines.length - 1) {
                        text = text.trim() + "\\N";
                    }
                }
                text = text.trim();
                if (start_s === Infinity) start_s = 0;

                let next_start_s = null;
                if (i + linesPerPage < lines.length) {
                    let min_ns = Infinity;
                    const nextLines = lines.slice(i + linesPerPage, i + linesPerPage * 2);
                    for (const line of nextLines) {
                        for (const w of line) {
                            const ws = Number(w.start_s) || 0;
                            if (ws < min_ns) min_ns = ws;
                        }
                    }
                    if (min_ns !== Infinity) next_start_s = min_ns;
                }

                const startAss = formatAssTime(start_s);
                let endTimeS = next_start_s !== null ? Math.min(end_s + 1.0, next_start_s) : end_s + 2.0;
                const endAss = formatAssTime(endTimeS);

                assContent += `Dialogue: 0,${startAss},${endAss},Default,,0,0,0,,${text}\n`;
            }
        }

        const assFileName = `${song_id}.ass`;
        const assPath = path.join(process.cwd(), assFileName);
        const mp4FileName = `${song_id}.mp4`;
        const outputPath = path.join(process.cwd(), mp4FileName);
        
        fs.writeFileSync(assPath, assContent, 'utf8');

        // Download cover image if provided
        let coverImgPath = "public/img_cover.png";
        let isTempCover = false;
        const targetImageUrl = image_url || songData[0]?.image_url;
        
        if (targetImageUrl) {
            try {
                const imgRes = await fetch(targetImageUrl);
                if (imgRes.ok) {
                    const imgBuffer = await imgRes.arrayBuffer();
                    coverImgPath = `${song_id}.jpg`;
                    fs.writeFileSync(path.join(process.cwd(), coverImgPath), Buffer.from(imgBuffer));
                    isTempCover = true;
                }
            } catch (e) {
                console.log("Failed to download image_url, falling back to default.", e);
            }
        }

        // 5. Run FFmpeg (Pure Vertical 9:16 - No Effects)
        const filterComplex = `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920[bg];[bg]subtitles=${assFileName}[outv]`;
        
        const ffmpegCmd = `ffmpeg -y -loop 1 -t ${duration + 2} -i "${coverImgPath}" -i "${audioUrl}" -filter_complex "${filterComplex}" -map "[outv]" -map 1:a -c:v libx264 -preset veryfast -r 24 -pix_fmt yuv420p -c:a aac -b:a 192k -shortest "${mp4FileName}"`;

        console.log(`[FFmpeg] Executing command: ${ffmpegCmd}`);
        try {
            const { stdout, stderr } = await execAsync(ffmpegCmd);
            console.log(`[FFmpeg] stdout: ${stdout}`);
            console.log(`[FFmpeg] stderr: ${stderr}`);
        } catch (ffmpegErr: any) {
            console.error(`[FFmpeg] ERROR:`, ffmpegErr.message, ffmpegErr.stderr);
            throw new Error(`FFmpeg failed: ${ffmpegErr.message}`);
        }
        console.log("[FFmpeg] FFmpeg completed.");

        // 6. Upload to Cloudflare R2
        console.log("Uploading to R2...");
        const s3 = new S3Client({
            region: 'auto',
            endpoint: process.env.R2_ENDPOINT,
            credentials: {
                accessKeyId: process.env.R2_ACCESS_KEY_ID!,
                secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!
            }
        });

        const fileStream = fs.createReadStream(outputPath);
        const r2Key = `video/${song_id}.mp4`;
        
        await s3.send(new PutObjectCommand({
            Bucket: process.env.R2_BUCKET,
            Key: r2Key,
            Body: fileStream,
            ContentType: 'video/mp4'
        }));

        const publicUrl = `${process.env.R2_PUBLIC_URL}/${r2Key}`;
        console.log("Uploaded successfully:", publicUrl);

        // 7. Cleanup
        if (fs.existsSync(assPath)) fs.unlinkSync(assPath);
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        if (isTempCover) {
            const coverAbsPath = path.join(process.cwd(), coverImgPath);
            if (fs.existsSync(coverAbsPath)) fs.unlinkSync(coverAbsPath);
        }

        return NextResponse.json({ success: true, video_url: publicUrl });
    } catch (error: any) {
        console.error('Error generating video:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
