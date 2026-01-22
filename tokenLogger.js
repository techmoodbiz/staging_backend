import admin from 'firebase-admin';

const db = admin.firestore();

/**
 * Logs token usage to the user's history collection and updates global stats.
 * 
 * @param {string} userId - The UID of the user.
 * @param {string} action - The action name (e.g., 'AUDIT_CONTENT', 'GENERATE_TEXT').
 * @param {number} tokenCount - The number of tokens used.
 * @param {object} metadata - Additional details (e.g., brandId, fileName, status).
 */
export async function logTokenUsage(userId, action, tokenCount, metadata = {}) {
    if (!userId || tokenCount <= 0) return;

    try {
        const batch = db.batch();
        const userRef = db.collection('users').doc(userId);
        const historyRef = userRef.collection('usage_history').doc();

        // 1. Add to History Collection
        batch.set(historyRef, {
            action: action,
            tokens: tokenCount,
            details: metadata,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });

        // 2. Update Aggregated Stats (Atomic Increment)
        // using set with merge to ensure nested fields work even if document is partial
        batch.set(userRef, {
            usageStats: {
                totalTokens: admin.firestore.FieldValue.increment(tokenCount),
                requestCount: admin.firestore.FieldValue.increment(1),
                lastActiveAt: admin.firestore.FieldValue.serverTimestamp()
            }
        }, { merge: true });

        await batch.commit();
        // console.log(`[TokenLogger] Logged ${tokenCount} tokens for ${action}`);
    } catch (error) {
        console.error("[TokenLogger] Failed to log usage:", error);
    }
}
