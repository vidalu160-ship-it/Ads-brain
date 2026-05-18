const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

module.exports = {
  expo: {
    name: 'AdsBrain AI',
    slug: 'adsbrain',
    scheme: 'adsbrain',
    version: '1.0.0',
    orientation: 'portrait',
    icon: './assets/icon.png',
    userInterfaceStyle: 'dark',
    splash: {
      image: './assets/splash-icon.png',
      resizeMode: 'contain',
      backgroundColor: '#09090F',
    },
    ios: {
      supportsTablet: false,
      bundleIdentifier: 'com.vidalu160.adsbrain',
    },
    android: {
      adaptiveIcon: {
        foregroundImage: './assets/adaptive-icon.png',
        backgroundColor: '#09090F',
      },
      package: 'com.vidalu160.adsbrain',
      intentFilters: [
        {
          action: 'VIEW',
          data: [{ scheme: 'adsbrain' }],
          category: ['BROWSABLE', 'DEFAULT'],
        },
      ],
    },
    web: {
      favicon: './assets/favicon.png',
    },
    plugins: ['expo-secure-store', 'expo-web-browser'],
    updates: {
      url: 'https://u.expo.dev/d18199ae-6244-4c98-af14-bbc603977d28',
    },
    runtimeVersion: {
      policy: 'appVersion',
    },
    extra: {
      supabaseUrl: process.env.SUPABASE_URL,
      supabaseKey: process.env.SUPABASE_KEY,
      claudeKey: process.env.CLAUDE_KEY,
      googleClientId: process.env.GOOGLE_CLIENT_ID,
      googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
      googleDevToken: process.env.GOOGLE_DEV_TOKEN,
      mccCustomerId: process.env.MCC_CUSTOMER_ID,
      eas: { projectId: 'd18199ae-6244-4c98-af14-bbc603977d28' },
    },
  },
};
