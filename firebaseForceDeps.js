// Vercel can miss transitive deps when firebase-admin is loaded dynamically.
// These imports force bundlers/tracers to include gaxios/gcp-metadata in the artifact.
import "gaxios/build/src/index.js";
import "gcp-metadata/build/src/index.js";
import "google-auth-library/build/src/index.js";

export {};
