/**
 * Centralized configuration for AICLIPS Generator.
 * All environment variables are loaded from here.
 */

const config = {
  appName: "Aiclips Generator",

  // =========================
  // Authentication
  // =========================
  auth: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    },

    secret: process.env.NEXTAUTH_SECRET,

    url:
      process.env.NEXTAUTH_URL ||
      "http://localhost:3000",

    webhook_url:
      process.env.WEBHOOK_URL ||
      process.env.NEXTAUTH_URL ||
      "http://localhost:3000",
  },

  // =========================
  // Stripe
  // =========================
  stripe: {
    publishableKey:
      process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,

    secretKey:
      process.env.STRIPE_SECRET_KEY,

    webhookSecret:
      process.env.STRIPE_WEBHOOK_SECRET,

    plans: {
      default: {
        amount: 50,
        price: 900,
        currency: "usd",
      },
    },
  },

  // =========================
  // AI / Video Processing
  // =========================
  ai: {
    aiclips: {
      apiKey:
        process.env.TWELVELABS_API_KEY,

      // Local video processing
      youtubeDownload: {
        enabled: true,
        ytdlpPath:
          process.env.YTDLP_PATH ||
          "C:\\Users\\PC\\AppData\\Local\\Microsoft\\WinGet\\Packages\\yt-dlp.yt-dlp_Microsoft.Winget.Source_8wekyb3d8bbwe\\yt-dlp.exe",

        ffmpegPath:
          process.env.FFMPEG_PATH ||
          "C:\\ffmpeg\\bin\\ffmpeg.exe",
      },

      // TwelveLabs API
      twelveLabs: {
        baseUrl:
          process.env.TWELVELABS_BASE_URL ||
          "https://api.twelvelabs.io/v1.3",
      },
    },
  },

  // =========================
  // Database
  // =========================
  db: {
    url: process.env.DATABASE_URL,
    directUrl: process.env.DIRECT_URL,
  },
};

// =========================
// Configuration validation
// =========================

const requiredKeys = [
  [
    "GOOGLE_CLIENT_ID",
    config.auth.google.clientId,
  ],

  [
    "GOOGLE_CLIENT_SECRET",
    config.auth.google.clientSecret,
  ],

  [
    "NEXTAUTH_SECRET",
    config.auth.secret,
  ],

  [
    "DATABASE_URL",
    config.db.url,
  ],

  [
    "TWELVELABS_API_KEY",
    config.ai.aiclips.apiKey,
  ],
];

if (typeof window === "undefined") {
  requiredKeys.forEach(([name, value]) => {
    if (!value) {
      console.warn(
        `[CONFIG] Warning: Missing environment variable: ${name}`
      );
    }
  });
}

export default config;