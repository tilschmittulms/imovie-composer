import express from "express";
import cors from "cors";
import fs from "fs";
import { runPipeline, CompileRequest } from "./pipeline";

const app = express();
app.use(cors({ origin: "*"}));
app.use(express.json({ limit: "25mb" }));

app.get("/healthz", (_req, res) => res.send("ok"));

app.post("/compile", async (req, res) => {
  try {
    const { images, imagesB64, videos, imageDurationSec } = req.body as any;

    // If base64 images provided, write them to /tmp and use those paths
    if (Array.isArray(imagesB64) && imagesB64.length) {
      const d = fs.mkdtempSync(path.join("/tmp", "b64-"));
      const toPath = (i: number) => path.join(d, `img_${i}.png`);
      for (let i = 0; i < imagesB64.length; i++) {
        const m = imagesB64[i].match(/^data:image\/\w+;base64,(.+)$/);
        if (!m) throw new Error("Invalid data URL");
        fs.writeFileSync(toPath(i), Buffer.from(m[1], "base64"));
      }
      const out = await runPipeline({
        images: imagesB64.map((_, i) => toPath(i)),
        videos,
        imageDurationSec,
      });
      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("Content-Disposition", 'inline; filename="final.mp4"');
      return fs.createReadStream(out).pipe(res);
    }

    // Fallback: URLs
    const out = await runPipeline({ images, videos, imageDurationSec });
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", 'inline; filename="final.mp4"');
    return fs.createReadStream(out).pipe(res);
  } catch (e: any) {
    console.error("compile error:", e);
    res.status(500).json({ error: e.message || "Compile failed" });
  }
});


const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`🎬 Worker listening on :${port}`));
