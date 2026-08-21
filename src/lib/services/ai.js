import { prisma } from "@/lib/prisma";
import config from "@/lib/config";
import fs from "fs/promises";
import path from "path";
import { spawn } from "child_process";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const YTDLP_PATH =
  config.ai.aiclips.youtubeDownload.ytdlpPath;

const FFMPEG_PATH =
  config.ai.aiclips.youtubeDownload.ffmpegPath;

const TWELVELABS_API =
  config.ai.aiclips.twelveLabs.baseUrl;

/* =========================================================
   HELPERS
========================================================= */

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_PATH, args, {
      windowsHide: true,
    });

    let stderr = "";

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `FFmpeg failed with code ${code}\n${stderr}`
          )
        );
      }
    });
  });
}

/* =========================================================
   YOUTUBE
========================================================= */

async function downloadYouTubeVideo(videoUrl, outputPath) {
  console.log("[AI_CLIPPING] Downloading video...");

  const commonArgs = [
    videoUrl,

    "--js-runtimes",
    "deno",

    "--no-playlist",

    "--ffmpeg-location",
    "C:\\ffmpeg\\bin",

    "-o",
    outputPath,
  ];

  const strategies = [
    // Strategy 1: web_safari
    [
      ...commonArgs,

      "--extractor-args",
      "youtube:player_client=web_safari",

      "-f",
      "best[height<=720]",
    ],

    // Strategy 2: default clients
    [
      ...commonArgs,

      "--extractor-args",
      "youtube:player_client=default",

      "-f",
      "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best[height<=720]",
    ],

    // Strategy 3: web_embedded
    [
      ...commonArgs,

      "--extractor-args",
      "youtube:player_client=web_embedded",

      "-f",
      "bestvideo[height<=720]+bestaudio/best[height<=720]",
    ],

    // Strategy 4: fallback to any available video
    [
      ...commonArgs,

      "-f",
      "best",
    ],
  ];

  let lastError = null;

  for (let i = 0; i < strategies.length; i++) {
    try {
      console.log(
        `[AI_CLIPPING] Download strategy ${i + 1}/${strategies.length}...`
      );

      await execFileAsync(
        YTDLP_PATH,
        strategies[i],
        {
          windowsHide: true,
          maxBuffer: 50 * 1024 * 1024,
        }
      );

      // Make sure the file actually exists
      const stats = await fs.stat(outputPath);

      if (stats.size > 100000) {
        console.log(
          `[AI_CLIPPING] Video downloaded successfully: ${stats.size} bytes`
        );

        return;
      }

      throw new Error(
        "yt-dlp finished but the downloaded file is empty or too small."
      );
    } catch (error) {
      lastError = error;

      console.warn(
        `[AI_CLIPPING] Strategy ${i + 1} failed. Trying next strategy...`
      );

      console.warn(error.message);

      // Remove incomplete file before trying again
      try {
        await fs.rm(outputPath, {
          force: true,
        });
      } catch {}
    }
  }

  throw new Error(
    `Unable to download this YouTube video with any supported method.\n\nLast error:\n${lastError?.message || "Unknown error"}`
  );
}

async function getYoutubeDuration(videoUrl) {
  try {
    const { stdout } = await execFileAsync(
      YTDLP_PATH,
      [
        videoUrl,

        "--js-runtimes",
        "deno",

        "--extractor-args",
        "youtube:player_client=web_safari",

        "--dump-single-json",

        "--no-download",

        "--no-playlist",
      ],
      {
        windowsHide: true,
        maxBuffer: 20 * 1024 * 1024,
      }
    );

    const data = JSON.parse(stdout);

    return Number(data.duration) || 300;
  } catch (error) {
    console.warn(
      "[GET_YT_DURATION_ERROR]",
      error.message
    );

    return 300;
  }
}

/* =========================================================
   TWELVE LABS - UPLOAD
========================================================= */

async function uploadToTwelveLabs(
  filePath,
  apiKey
) {
  console.log(
    "[AI_CLIPPING] Uploading video to TwelveLabs..."
  );

  const buffer = await fs.readFile(filePath);

  const form = new FormData();

  form.append(
    "method",
    "direct"
  );

  form.append(
    "file",
    new Blob([buffer], {
      type: "video/mp4",
    }),
    path.basename(filePath)
  );

  const response = await fetch(
    `${TWELVELABS_API}/assets`,
    {
      method: "POST",

      headers: {
        "x-api-key": apiKey,
      },

      body: form,
    }
  );

  if (!response.ok) {
    const text = await response.text();

    throw new Error(
      `TwelveLabs upload failed: ${response.status} ${text}`
    );
  }

  const data = await response.json();

  console.log(
    "[AI_CLIPPING] TwelveLabs asset created:",
    data._id
  );

  return data;
}

/* =========================================================
   TWELVE LABS - WAIT FOR ASSET
========================================================= */

async function waitForAsset(
  assetId,
  apiKey
) {
  console.log(
    `[AI_CLIPPING] Waiting for asset ${assetId}...`
  );

  for (
    let attempt = 0;
    attempt < 120;
    attempt++
  ) {
    const response = await fetch(
      `${TWELVELABS_API}/assets/${assetId}`,
      {
        method: "GET",

        headers: {
          "x-api-key": apiKey,
        },
      }
    );

    if (!response.ok) {
      const text = await response.text();

      throw new Error(
        `TwelveLabs asset check failed: ${response.status} ${text}`
      );
    }

    const asset =
      await response.json();

    console.log(
      `[AI_CLIPPING] Asset status: ${asset.status}`
    );

    if (
      asset.status ===
      "ready"
    ) {
      return asset;
    }

    if (
      asset.status ===
      "failed"
    ) {
      throw new Error(
        "TwelveLabs failed to process the uploaded video."
      );
    }

    await new Promise(
      (resolve) =>
        setTimeout(resolve, 5000)
    );
  }

  throw new Error(
    "Timed out waiting for TwelveLabs to process the video."
  );
}

/* =========================================================
   TWELVE LABS - ANALYSIS
========================================================= */

async function createHighlightTask(
  assetId,
  apiKey
) {
  console.log(
    "[AI_CLIPPING] Asking TwelveLabs to find highlights..."
  );

  const response = await fetch(
    `${TWELVELABS_API}/analyze/tasks`,
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/json",

        "x-api-key":
          apiKey,
      },

      body: JSON.stringify({
        video: {
          type: "asset_id",
          asset_id: assetId,
        },

        model_name:
          "pegasus1.5",

        analysis_mode:
          "time_based_metadata",

        response_format: {
          type:
            "segment_definitions",

          segment_definitions: [
            {
              id:
                "highlights",

              description:
                "Find the most engaging, surprising, funny, emotional, educational, controversial, or viral-worthy moments. Prioritize moments that work as standalone TikTok, YouTube Shorts, or Instagram Reels clips. Avoid introductions, greetings, silence, filler, advertisements, repetitive sections, and boring parts.",

              fields: [
                {
                  name:
                    "reason",

                  type:
                    "string",

                  description:
                    "Explain briefly why this segment is a strong short-form clip.",
                },

                {
                  name:
                    "score",

                  type:
                    "number",

                  description:
                    "Rate the viral potential from 0 to 100.",
                },
              ],
            },
          ],

          segment_time_format:
            "seconds",
        },
      }),
    }
  );

  if (!response.ok) {
    const text =
      await response.text();

    throw new Error(
      `TwelveLabs analysis failed: ${response.status} ${text}`
    );
  }

  return await response.json();
}

/* =========================================================
   TWELVE LABS - CHECK TASK
========================================================= */

async function getAnalysisTask(
  taskId,
  apiKey
) {
  const response = await fetch(
    `${TWELVELABS_API}/analyze/tasks/${taskId}`,
    {
      method: "GET",

      headers: {
        "x-api-key":
          apiKey,
      },
    }
  );

  if (!response.ok) {
    const text =
      await response.text();

    throw new Error(
      `TwelveLabs task check failed: ${response.status} ${text}`
    );
  }

  return await response.json();
}

/* =========================================================
   FFMPEG - CREATE CLIP
========================================================= */

async function createVerticalClip(
  inputPath,
  outputPath,
  start,
  duration
) {
  await runFFmpeg([
    "-y",

    "-ss",
    String(start),

    "-i",
    inputPath,

    "-t",
    String(duration),

    "-vf",
    "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920",

    "-c:v",
    "libx264",

    "-preset",
    "veryfast",

    "-crf",
    "23",

    "-c:a",
    "aac",

    "-movflags",
    "+faststart",

    outputPath,
  ]);
}

/* =========================================================
   AI SERVICE
========================================================= */

export const AIService = {
  /* -------------------------------------------------------
     YOUTUBE DURATION
  ------------------------------------------------------- */

  async getYoutubeDuration(
    videoUrl
  ) {
    return await getYoutubeDuration(
      videoUrl
    );
  },

  /* -------------------------------------------------------
     YOUTUBE DOWNLOAD
  ------------------------------------------------------- */

  async youtubeDownload(
    userId,
    {
      video_url,
      format = "720",
    }
  ) {
    const workDir =
      path.join(
        process.cwd(),
        "tmp",
        "aiclips"
      );

    await fs.mkdir(
      workDir,
      {
        recursive: true,
      }
    );

    const id =
      `${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}`;

    const outputPath =
      path.join(
        workDir,
        `${id}.mp4`
      );

    try {
      await downloadYouTubeVideo(
        video_url,
        outputPath
      );

      return {
        status:
          "completed",

        video_url:
          `/api/download?file=${encodeURIComponent(
            outputPath
          )}`,
      };
    } catch (error) {
      console.error(
        "[YOUTUBE_DOWNLOAD_ERROR]",
        error
      );

      throw error;
    }
  },

  /* -------------------------------------------------------
     AI CLIPPING
  ------------------------------------------------------- */

  async aiClipping(
    userId,
    {
      video_url,
      num_highlights = 3,
      aspect_ratio = "9:16",
      customApiKey = null,
    }
  ) {
    const numHighlights =
      Math.max(
        1,
        Math.min(
          Number(
            num_highlights
          ) || 3,
          10
        )
      );

    const isUsingCustomKey =
      Boolean(
        customApiKey &&
        customApiKey.trim()
      );

    const apiKey =
      isUsingCustomKey
        ? customApiKey.trim()
        : config.ai.aiclips.apiKey;

    if (!apiKey) {
      throw new Error(
        "TWELVELABS_API_KEY is not configured."
      );
    }

    console.log(
      "[AI_CLIPPING] Internal cost: 0 credits"
    );

    const workDir =
      path.join(
        process.cwd(),
        "tmp",
        "aiclips"
      );

    await fs.mkdir(
      workDir,
      {
        recursive: true,
      }
    );

    const id =
      `${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}`;

    const inputPath =
      path.join(
        workDir,
        `${id}.mp4`
      );

    try {
      /* Download */

      await downloadYouTubeVideo(
        video_url,
        inputPath
      );

      /* Check file */

      const stats =
        await fs.stat(
          inputPath
        );

      console.log(
        `[AI_CLIPPING] Video size: ${stats.size} bytes`
      );

      if (
        stats.size >
        200 * 1024 * 1024
      ) {
        throw new Error(
          "Video is larger than TwelveLabs' 200 MB direct upload limit."
        );
      }

      /* Upload */

      const asset =
        await uploadToTwelveLabs(
          inputPath,
          apiKey
        );

      if (!asset._id) {
        throw new Error(
          "TwelveLabs did not return an asset ID."
        );
      }

      /* Wait */

      const readyAsset =
        await waitForAsset(
          asset._id,
          apiKey
        );

      /* Analyze */

      const task =
        await createHighlightTask(
          readyAsset._id,
          apiKey
        );

      const requestId =
        task.task_id;

      if (!requestId) {
        throw new Error(
          "TwelveLabs did not return a task ID."
        );
      }

      /* Save to database */

      const creationModel =
        prisma.creation ||
        prisma.Creation;

      if (creationModel) {
        await creationModel.create({
          data: {
            userId,

            type:
              "ai_clipping",

            aspectRatio:
              aspect_ratio,

            numClips:
              numHighlights,

            requestId,

            status:
              "processing",

            resultUrl:
              JSON.stringify({
                inputPath,

                assetId:
                  readyAsset._id,

                numHighlights,
              }),

            error:
              null,
          },
        });
      }

      console.log(
        `[AI_CLIPPING] Analysis task created: ${requestId}`
      );

      return {
        request_id:
          requestId,

        status:
          "processing",
      };
    } catch (error) {
      console.error(
        "[AI_CLIPPING_ERROR]",
        error
      );

      try {
        await fs.rm(
          inputPath,
          {
            force: true,
          }
        );
      } catch {}

      throw error;
    }
  },

  /* -------------------------------------------------------
     CHECK STATUS
  ------------------------------------------------------- */

  async checkStatus(
    requestId,
    customApiKey = null
  ) {
    const creationModel =
      prisma.creation ||
      prisma.Creation;

    if (!creationModel) {
      return {
        status:
          "processing",
      };
    }

    const creation =
      await creationModel.findUnique({
        where: {
          requestId,
        },
      });

    if (!creation) {
      return {
        status:
          "processing",
      };
    }

    /* Already completed */

    if (
      creation.status ===
      "completed"
    ) {
      try {
        const result =
          JSON.parse(
            creation.resultUrl ||
              "{}"
          );

        return {
          status:
            "completed",

          clips:
            result.clips ||
            [],
        };
      } catch {
        return {
          status:
            "completed",

          clips: [],
        };
      }
    }

    /* Already failed */

    if (
      creation.status ===
      "failed"
    ) {
      throw new Error(
        creation.error ||
          "Generation failed."
      );
    }

    const apiKey =
      customApiKey &&
      customApiKey.trim()
        ? customApiKey.trim()
        : config.ai.aiclips.apiKey;

    if (!apiKey) {
      throw new Error(
        "TWELVELABS_API_KEY is not configured."
      );
    }

    try {
      /* Get task */

      const task =
        await getAnalysisTask(
          requestId,
          apiKey
        );

      console.log(
        `[AI_CLIPPING] Task status: ${task.status}`
      );

      /* Still processing */

      if (
        task.status ===
          "queued" ||
        task.status ===
          "pending" ||
        task.status ===
          "processing"
      ) {
        return {
          status:
            "processing",
        };
      }

      /* Failed */

      if (
        task.status ===
        "failed"
      ) {
        const message =
          task.error?.message ||
          "TwelveLabs analysis failed.";

        await creationModel.update({
          where: {
            id:
              creation.id,
          },

          data: {
            status:
              "failed",

            error:
              message,
          },
        });

        throw new Error(
          message
        );
      }

      /* Not ready yet */

      if (
        task.status !==
        "ready"
      ) {
        return {
          status:
            "processing",
        };
      }

      /* Get results */

      const rawData =
        task.result?.data;

      if (!rawData) {
        throw new Error(
          "TwelveLabs returned no analysis data."
        );
      }

      const parsed =
        typeof rawData ===
        "string"
          ? JSON.parse(
              rawData
            )
          : rawData;

      let segments =
        parsed.highlights ||
        [];

      if (
        !Array.isArray(
          segments
        )
      ) {
        segments = [];
      }

      /* Sort and limit */

      segments =
        segments
          .filter(
            (segment) => {
              const start =
                Number(
                  segment.start_time
                );

              const end =
                Number(
                  segment.end_time
                );

              return (
                Number.isFinite(
                  start
                ) &&
                Number.isFinite(
                  end
                ) &&
                end > start
              );
            }
          )
          .sort(
            (a, b) =>
              Number(
                b.metadata
                  ?.score ||
                  0
              ) -
              Number(
                a.metadata
                  ?.score ||
                  0
              )
          )
          .slice(
            0,
            creation.numClips ||
              3
          );

      if (
        !segments.length
      ) {
        throw new Error(
          "TwelveLabs did not find any suitable highlights."
        );
      }

      /* Get original video */

      const stored =
        JSON.parse(
          creation.resultUrl ||
            "{}"
        );

      const inputPath =
        stored.inputPath;

      if (!inputPath) {
        throw new Error(
          "Original video file was not found."
        );
      }

      /* Output directory */

      const outputDir =
        path.join(
          process.cwd(),
          "public",
          "generated"
        );

      await fs.mkdir(
        outputDir,
        {
          recursive: true,
        }
      );

      const clips = [];

      /* Create clips */

      for (
        let i = 0;
        i < segments.length;
        i++
      ) {
        const segment =
          segments[i];

        const start =
          Number(
            segment.start_time
          );

        const end =
          Number(
            segment.end_time
          );

        const duration =
          end - start;

        if (
          duration < 3
        ) {
          continue;
        }

        const filename =
          `${requestId}-${i + 1}.mp4`;

        const outputPath =
          path.join(
            outputDir,
            filename
          );

        console.log(
          `[AI_CLIPPING] Creating clip ${i + 1}: ${start}s - ${end}s`
        );

        await createVerticalClip(
          inputPath,
          outputPath,
          start,
          duration
        );

        clips.push(
          `/generated/${filename}`
        );
      }

      if (
        !clips.length
      ) {
        throw new Error(
          "FFmpeg could not create any clips."
        );
      }

      /* Save result */

      await creationModel.update({
        where: {
          id:
            creation.id,
        },

        data: {
          status:
            "completed",

          resultUrl:
            JSON.stringify({
              clips,

              segments,
            }),
        },
      });

      /* Remove original */

      try {
        await fs.rm(
          inputPath,
          {
            force: true,
          }
        );
      } catch {}

      console.log(
        `[AI_CLIPPING] Completed ${clips.length} clips.`
      );

      return {
        status:
          "completed",

        clips,
      };
    } catch (error) {
      console.error(
        "[CHECK_STATUS_ERROR]",
        error
      );

      await creationModel.update({
        where: {
          id:
            creation.id,
        },

        data: {
          status:
            "failed",

          error:
            error.message ||
            "Generation failed.",
        },
      });

      throw error;
    }
  },
};