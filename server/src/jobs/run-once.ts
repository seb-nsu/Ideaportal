import { closePool } from '../db/pool.js';
import { runAllJobs } from './deadlines.js';

const today = process.argv[2];
runAllJobs(today)
  .then((r) => console.log(JSON.stringify(r, null, 2)))
  .finally(() => closePool());
