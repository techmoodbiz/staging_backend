// Force Vercel/NFT to include transitive Google auth deps
// when `firebase-admin` is loaded dynamically.
import "gaxios";
import "gcp-metadata";
import "google-auth-library";

export {};

