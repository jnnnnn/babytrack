export default [
  {
    files: ["server/static/*.js"],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: "script",
      globals: {
        // Browser globals
        window: "readonly",
        document: "readonly",
        localStorage: "readonly",
        fetch: "readonly",
        navigator: "readonly",
        alert: "readonly",
        confirm: "readonly",
        prompt: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        setInterval: "readonly",
        clearTimeout: "readonly",
        clearInterval: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        WebSocket: "readonly",
        Blob: "readonly",
        FileReader: "readonly",
        Event: "readonly",
        CustomEvent: "readonly",
        HTMLElement: "readonly",
        indexedDB: "readonly",
        IDBKeyRange: "readonly",
        crypto: "readonly",
        getComputedStyle: "readonly",
        // External libs
        d3: "readonly",
        SyncClient: "readonly",
      },
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": ["warn", { args: "none", varsIgnorePattern: "^_" }],
    },
  },
];
