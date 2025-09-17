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
    const body = req.body as CompileRequest;

    // Basic validation
    if ((!body.images || body.images.length === 0) && (!body.videos || body.videos.length === 0)) {
      return res.status(400).json({ error: "Provide images[] and/or videos[] URLs." });
    }

    const outputPath = await runPipeline(body);

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", 'inline; filename="final.mp4"');

    const stream = fs.createReadStream(outputPath);
    stream.on("error", (e) => {
      console.error("stream error:", e);
      res.destroy(e);
    });
    stream.pipe(res);
  } catch (e: any) {
    console.error("compile error:", e);
    res.status(500).json({ error: e.message || "Compile failed" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`🎬 Worker listening on :${port}`));
