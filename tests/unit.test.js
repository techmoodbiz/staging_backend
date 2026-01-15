import { robustJSONParse, cosineSimilarity, semanticChunking } from '../utils.js';

describe('1. Core Logic & Utilities', () => {

    describe('robustJSONParse (audit.js)', () => {
        test('UT-CORE-01: Valid JSON', () => {
            const input = '{"key": "val"}';
            expect(robustJSONParse(input)).toEqual({ key: "val" });
        });

        test('UT-CORE-02: Markdown Wrapped', () => {
            const input = '```json\n{"a": 1}\n```';
            expect(robustJSONParse(input)).toEqual({ a: 1 });
        });

        test('UT-CORE-03: Trailing Comma', () => {
            const input = '{"a": 1,}';
            expect(robustJSONParse(input)).toEqual({ a: 1 });
        });

        test('UT-CORE-04: Missing Quotes on Keys', () => {
            const input = '{key: "val"}';
            expect(robustJSONParse(input)).toEqual({ key: "val" });
        });

        test('UT-CORE-05: Fatal Error', () => {
            const input = 'Not JSON';
            expect(robustJSONParse(input)).toBeNull();
        });
    });

    describe('cosineSimilarity (rag-generate.js)', () => {
        test('UT-CORE-06: Identical Vectors', () => {
            expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1.0);
        });

        test('UT-CORE-07: Orthogonal Vectors', () => {
            expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0.0);
        });

        test('UT-CORE-08: Dimensions Mismatch', () => {
            expect(cosineSimilarity([1], [1, 2])).toBe(0);
        });
    });

    describe('semanticChunking (approve-text-and-ingest.js)', () => {
        const textA = "This is paragraph A which is definitely longer than twenty characters.";
        const textB = "This is paragraph B which is also longer than twenty characters needed.";

        test('UT-CORE-09: Basic Paragraphs', () => {
            // maxChunkSize small enough to force split
            // textA len ~70. textB len ~70.
            // If maxChunkSize = 100, they fit individually.
            // Combined = 140 + 2 = 142 > 100. So should split.
            const input = `${textA}\n\n${textB}`;
            const chunks = semanticChunking(input, 100, 10);
            expect(chunks.length).toBe(2);
            expect(chunks[0].text).toBe(textA);
            expect(chunks[1].text).toBe(textB);
        });

        test('UT-CORE-10: Small Merging', () => {
            // Chunk size > total length -> should merge
            const input = `${textA}\n\n${textB}`;
            // maxChunkSize = 500. fits both.
            const chunks = semanticChunking(input, 500, 10);
            expect(chunks.length).toBe(1);
            expect(chunks[0].text).toContain(textA);
            expect(chunks[0].text).toContain(textB);
        });

        test('UT-CORE-11: Long Sentence Split', () => {
            // Create a long paragraph
            const longPart = "This is a very long sentence segment that repeats ".repeat(20); // ~1000 chars
            const longSentence = longPart + ". " + longPart + ".";
            // maxChunkSize = 500. Total ~2000. Should split.
            const chunks = semanticChunking(longSentence, 500, 100);
            expect(chunks.length).toBeGreaterThanOrEqual(2);
        });
    });

});
