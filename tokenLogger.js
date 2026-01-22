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
        // Construct the update object dynamically
        const updateData = {
            'usageStats.totalTokens': admin.firestore.FieldValue.increment(tokenCount),
            'usageStats.requestCount': admin.firestore.FieldValue.increment(1),
            'usageStats.lastActiveAt': admin.firestore.FieldValue.serverTimestamp(),
            [`usageStats.breakdown.${action}`]: admin.firestore.FieldValue.increment(tokenCount)
        };

        batch.update(userRef, updateData); // Use update to avoid overwriting unrelated fields if we were using set. 
        // Actually, earlier I used set({ usageStats... }, {merge: true}). 
        // update is cleaner for dot notation but requires document existence. 
        // Given users must exist to have usage, update is safe. 
        // If we want to be super safe, we keep set with merge but formats differ.
        // Let's stick to set with merge for safety if we change schema later, 
        // BUT dot notation for nested fields in `set` with `merge` behaves like update.

        // Simplest robust way:
        batch.set(userRef, updateData, { merge: true });

        await batch.commit();
        // console.log(`[TokenLogger] Logged ${tokenCount} tokens for ${action}`);
    } catch (error) {
        console.error("[TokenLogger] Failed to log usage:", error);
    }
}
