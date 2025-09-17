import { spawn } from "child_process";
import fs from "fs";
import path from "path";

function sh(cmd: string, args: string[], inherit = true) {
  return new Promise<void>((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: inherit ? "inherit" : "pipe" });
    p.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))
    );
  });
}

async function fetchToFile(url: string, destPath: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });

  // Node 18/20/22-safe: use arrayBuffer, then write
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.promises.writeFile(destPath, buf);
}


export async function imageToClip(imagePath: string, output: string, duration = 5) {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const args = [
    "-y",
    "-loop", "1",
    "-i", imagePath,
    "-f", "lavfi", "-t", String(duration),
    "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
    "-shortest",
    "-vf",
    "fps=24,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,format=yuv420p",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "21",
    "-c:a", "aac",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    output
  ];
  await sh("ffmpeg", args);
}

type Probe = { hasAudio: boolean; duration: number };
async function probe(file: string): Promise<Probe> {
  const get = (args: string[]) =>
    new Promise<string>((resolve, reject) => {
      const p = spawn("ffprobe", args);
      let out = "", err = "";
      p.stdout.on("data", (d) => (out += d.toString()));
      p.stderr.on("data", (d) => (err += d.toString()));
      p.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err))));
    });

  const durationStr = await get(["-v","error","-show_entries","format=duration","-of","default=noprint_wrappers=1:nokey=1",file]);
  const duration = Math.max(0, parseFloat(durationStr) || 0);
  let hasAudio = false;
  try {
    const streams = await get(["-v","error","-select_streams","a","-show_entries","stream=index","-of","csv=p=0",file]);
    hasAudio = streams.trim().length > 0;
  } catch { hasAudio = false; }
  return { hasAudio, duration };
}

export async function normalizeClip(input: string, output: string) {
  const { hasAudio, duration } = await probe(input);
  const args: string[] = ["-y", "-i", input];

  if (!hasAudio) {
    const dur = Math.max(0.01, duration || 5);
    args.push("-f","lavfi","-t",String(dur),"-i","anullsrc=channel_layout=stereo:sample_rate=44100");
  }

  args.push(
    "-map","0:v:0",
    "-vf","fps=24,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,format=yuv420p",
    "-c:v","libx264","-preset","veryfast","-crf","21",
    "-pix_fmt","yuv420p",
    "-movflags","+faststart",
  );

  if (hasAudio) {
    args.push("-map","0:a:0","-af","aformat=sample_rates=44100:channel_layouts=stereo","-c:a","aac");
  } else {
    args.push("-map","1:a:0","-c:a","aac");
  }
  args.push(output);
  await sh("ffmpeg", args);
}

export async function concatNormalized(inputs: string[], output: string) {
  const listPath = path.resolve("/tmp/concat.txt");
  fs.writeFileSync(listPath, inputs.map((f) => `file '${f.replace(/'/g,"'\\''")}'`).join("\n"));
  await sh("ffmpeg", ["-y","-f","concat","-safe","0","-i", listPath,"-c","copy","-movflags","+faststart", output]);
}

export type CompileRequest = {
  images?: string[];      // array of image URLs
  videos?: string[];      // array of video URLs (optional)
  imageDurationSec?: number; // default per-image duration if no VO
  voiceoverUrl?: string;  // optional: single VO; (future) per-scene VO
};

export async function runPipeline(req: CompileRequest): Promise<string> {
  const tmp = "/tmp"; // Render-friendly
  const d = fs.mkdtempSync(path.join(tmp, "job-"));

  const imageDur = req.imageDurationSec ?? 5;

  // 1) Download inputs
  const imagePaths: string[] = [];
  for (let i = 0; i < (req.images?.length || 0); i++) {
    const p = path.join(d, `img_${i}.png`);
    await fetchToFile(req.images![i], p);
    imagePaths.push(p);
  }

  const videoPaths: string[] = [];
  for (let i = 0; i < (req.videos?.length || 0); i++) {
    const p = path.join(d, `vid_${i}.mp4`);
    await fetchToFile(req.videos![i], p);
    videoPaths.push(p);
  }

  // 2) Build clips from images
  const clipPaths: string[] = [];
  for (let i = 0; i < imagePaths.length; i++) {
    const out = path.join(d, `imgclip_${i}.mp4`);
    await imageToClip(imagePaths[i], out, imageDur);
    clipPaths.push(out);
  }

  // 3) Add raw videos to list
  clipPaths.push(...videoPaths);

  // 4) Normalize each
  const norm: string[] = [];
  for (let i = 0; i < clipPaths.length; i++) {
    const out = path.join(d, `norm_${i}.mp4`);
    await normalizeClip(clipPaths[i], out);
    norm.push(out);
  }

  // 5) Concat
  const finalOut = path.join(d, "final.mp4");
  await concatNormalized(norm, finalOut);
  return finalOut; // caller streams this file
}
