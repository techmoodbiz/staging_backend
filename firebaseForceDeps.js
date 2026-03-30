// Vercel can miss transitive deps when firebase-admin is loaded dynamically.
// These imports force bundlers/tracers to include gaxios/gcp-metadata in the artifact.
import "gaxios";
import "gcp-metadata";
import "google-auth-library";

export {};
