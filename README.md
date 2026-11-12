# Standin

**The cloud writes the letter. It never learns who it is about.**

Live app: https://didrod205.github.io/standin/

## One-minute version

- People need strong writing help most when their notes are the most private: a landlord dispute, a medical bill, an HR complaint, a letter about a child's health.
- Standin splits the job. A model **on your device** finds names, addresses, health details, money amounts and contact details, and swaps each one for a stand-in such as `[PERSON_1]`.
- Only the masked text goes to the **cloud** model, which does the heavy writing (letters, emails, summaries).
- The real details are swapped back **on your device**. A leak check blocks sending if any real value is still in the outbound text, and a privacy receipt lists every AI call and where it ran.

## Why it has to be hybrid

| Step | Where it runs | Firebase AI Logic mode | Why |
|---|---|---|---|
| 1. Find private details | On this device only (Gemini Nano in Chrome), plus local rules | `InferenceMode.ONLY_ON_DEVICE` | Sending the raw notes to the cloud to find what is private would defeat the purpose. If no on-device model is available, the app says so and uses local rules (regex and word lists); it never falls back to the cloud for this step. |
| 2. Write the draft | Cloud when online (`gemini-3.6-flash`, then `gemini-3.5-flash-lite`), Gemini Nano when offline | `InferenceMode.PREFER_IN_CLOUD` | Long, well-structured writing benefits from a larger model. Offline, the same call falls back to the device. |
| 3. Restore real details | This device, plain code | none | Swapping tokens back is a deterministic string operation; no model needed. |

Each response's `inferenceSource` (reported by Firebase AI Logic) is written into the privacy receipt, so the user sees where every call actually ran.

## What you see in each environment

| Browser | Status chip | Found-detail tags | Receipt "Ran" for masking |
|---|---|---|---|
| Chrome desktop 139+ with Gemini Nano available | green dot, "On-device model: Gemini Nano ready" | `Nano` for items the model found, `local rule` for items the rules found | `ON_DEVICE` (from Firebase AI Logic `inferenceSource`) |
| Any browser without a usable on-device model | grey dot, "On-device model: not available here", plus the note "On-device model not available in this browser. Masking runs locally with on-device rules; nothing is sent." | `local rule` | `ON_DEVICE (rules)` |

In both cases the masking step never calls the cloud. If the on-device model is missing, or returns something that is not valid JSON, the app falls back to the local rules and says so.

Note on the demo video: it was recorded in a browser where Gemini Nano did not actually run (the Prompt API was present but returned no usable answer), so the video shows the local-rules path for masking and the real cloud path for writing. The Nano path is implemented in `app.js` (`InferenceMode.ONLY_ON_DEVICE` with a JSON schema) but is not shown running in the video.

## How Firebase AI Logic is used (code)

- `app.js` imports `getAI`, `getGenerativeModel`, `GoogleAIBackend`, `InferenceMode` and `Schema` from the Firebase JS SDK 13.3.0 and calls `generateContent()` at runtime.
- The masking model uses structured output (`responseMimeType: 'application/json'` with a `Schema.object`) so the on-device model returns a list of `{ value, kind }`.
- `initializeDeviceModel()` is called inside the button click, as Chrome requires user activation.
- App Check is enabled with the reCAPTCHA Enterprise (Fraud Defense) provider.
- `redact.js` holds the local rules, the token map, the leak check and the restore step. It has no network code.

## Run it yourself

1. Create a Firebase project (Spark plan is enough), add a web app, open **AI Services > AI Logic**, choose **Gemini Developer API** and finish the setup.
2. In **App Check**, register the web app with a reCAPTCHA Enterprise site key for your domain (or use a debug token for localhost: run `localStorage.setItem('standin_debug_token', '<token>')` in the console and register that token in the Firebase console).
3. Put your values in `config.js`.
4. Serve the folder with any static server, for example `python3 -m http.server 8080`, and open `http://localhost:8080`.
5. For on-device inference use Chrome on desktop 139 or newer and enable `chrome://flags/#prompt-api-for-gemini-nano-multimodal-input`.

No build step and no bundler: the app is plain ES modules loaded from the official Firebase CDN.

## Honest limits

- On-device masking is only as good as the on-device model. Always review the list of found details; you can tap any item to keep or hide it, or add your own phrase.
- Local rules are a safety net, not a replacement: without an on-device model, unusual names or health details can be missed. The status chip says which method was used.
- The stand-in key lives only in the page's memory. Reloading the page clears it.

## Built with

Firebase AI Logic (hybrid inference, Gemini Developer API, Gemini Nano via Chrome Prompt API), Firebase App Check (reCAPTCHA Enterprise), plain HTML, CSS and JavaScript, GitHub Pages.

## AI use

Built with Claude (AI agent). The concept, code, interface text and this README were produced by Claude, an AI agent by Anthropic, working on behalf of Kyoungchan Yang (E:LAB STUDIO). The sample notes in the app are fictional.

## License

Apache License 2.0
