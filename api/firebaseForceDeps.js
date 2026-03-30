// Force Vercel/NFT to include transitive Google auth deps
// when `firebase-admin` is loaded dynamically.
import "gaxios/build/src/index.js";
import "gcp-metadata/build/src/index.js";
import "google-auth-library/build/src/index.js";

export {};

