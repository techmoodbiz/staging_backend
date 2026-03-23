import { BigQuery } from '@google-cloud/bigquery';
import dotenv from 'dotenv';

dotenv.config();

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const GA4_DATASET = process.env.GA4_DATASET_ID;
const GSC_DATASET = process.env.GSC_DATASET_ID;
const LOCATION = process.env.BIGQUERY_LOCATION || 'asia-southeast1';

const bigquery = new BigQuery({
  projectId: PROJECT_ID,
  location: LOCATION,
  credentials: {
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
    private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  }
});

async function diagnose() {
  console.log('--- BIGQUERY DIAGNOSTIC ---');
  console.log(`Project ID: ${PROJECT_ID}`);
  console.log(`Location  : ${LOCATION}`);
  console.log(`GA4 Dataset: ${GA4_DATASET}`);
  console.log(`GSC Dataset: ${GSC_DATASET}`);
  console.log('---------------------------');

  try {
    console.log('\n1. Testing Project Access...');
    const [datasets] = await bigquery.getDatasets();
    console.log('✅ Successfully connected to project. Found datasets:', datasets.map(d => d.id).join(', '));
  } catch (err) {
    console.error('❌ Failed to list datasets:', err.message);
  }

  if (GA4_DATASET) {
    try {
      console.log(`\n2. Testing GA4 Dataset Access (${GA4_DATASET})...`);
      const [tables] = await bigquery.dataset(GA4_DATASET).getTables();
      console.log(`✅ Successfully accessed GA4 dataset. Tables found:`, tables.map(t => t.id).join(', '));
      
      const hasEvents = tables.some(t => t.id.startsWith('events_'));
      if (hasEvents) {
        console.log('✅ Found events_* tables.');
      } else {
        console.warn('⚠️ No events_* tables found. BigQuery might not have exported data yet.');
      }
    } catch (err) {
      console.error(`❌ Failed to access GA4 dataset:`, err.message);
    }
  }

  if (GSC_DATASET) {
    try {
      console.log(`\n3. Testing GSC Dataset Access (${GSC_DATASET})...`);
      const [tables] = await bigquery.dataset(GSC_DATASET).getTables();
      console.log(`✅ Successfully accessed GSC dataset. Tables found:`, tables.map(t => t.id).join(', '));
    } catch (err) {
      console.error(`❌ Failed to access GSC dataset:`, err.message);
    }
  }
}

diagnose();
