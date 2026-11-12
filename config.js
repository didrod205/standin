// Public Firebase web config (these values are identifiers, not secrets).
export const firebaseConfig = {
  apiKey: "AIzaSyB65EZXg2t27y6cbZN_mxHKVY7z7f9r2OY",
  authDomain: "standin-hybrid.firebaseapp.com",
  projectId: "standin-hybrid",
  storageBucket: "standin-hybrid.firebasestorage.app",
  messagingSenderId: "641102066350",
  appId: "1:641102066350:web:c342fa82562cc46493333f"
};

// App Check with reCAPTCHA Enterprise (Fraud Defense). The site key is public by design.
// For local development you can set a debug token in the browser console:
//   localStorage.setItem('standin_debug_token', '<token registered in the Firebase console>')
export const appCheckConfig = {
  recaptchaEnterpriseSiteKey: '6LdjLBwuAAAAAHXNrRdB80sF2I2K0OAKNGiEULEA',
  debugToken: localStorage.getItem('standin_debug_token') || null,
};
