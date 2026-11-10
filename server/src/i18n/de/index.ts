import { common } from './common.js';
import { auth } from './auth.js';
import { ideas } from './ideas.js';
import { admin } from './admin.js';
import { pilot } from './pilot.js';
import { selfservice } from './selfservice.js';
import { misc } from './misc.js';
import { elaboration } from './elaboration.js';
import { workflow } from './workflow.js';
import { recognition } from './recognition.js';
import { ai } from './ai.js';
import { aiq } from './aiq.js';
import { mail } from './mail.js';
import { jobs } from './jobs.js';
import { files } from './files.js';
import { ops } from './ops.js';
import { challenges } from './challenges.js';
import { identity } from './identity.js';
import { saml } from './saml.js';
import { codet } from './codet.js';
import { chat } from './chat.js';
import { aiout } from './aiout.js';
import { defaults } from './defaults.js';
import { api } from './api.js';
import { conn } from './conn.js';
import { compliance } from './compliance.js';
import { areas } from './areas.js';
import { external } from './external.js';
import { usecases } from './usecases.js';
import { saas } from './saas.js';
import { insights } from './insights.js';
import { billing } from './billing.js';
import { processTexts } from './process.js';
import { radar } from './radar.js';
import { learning } from './learning.js';
import { importAi } from './importAi.js';
import { security } from './security.js';
import { enterprise } from './enterprise.js';
import { aieval } from './aieval.js';
import { aigw } from './aigw.js';

// German catalogue (reference). One file per namespace; keys carry the namespace.
export const de = {
  ...common,
  ...auth,
  ...ideas,
  ...admin,
  ...pilot,
  ...selfservice,
  ...misc,
  ...elaboration,
  ...workflow,
  ...recognition,
  ...ai,
  ...aiq,
  ...mail,
  ...jobs,
  ...files,
  ...ops,
  ...challenges,
  ...identity,
  ...saml,
  ...codet,
  ...chat,
  ...aiout,
  ...defaults,
  ...api,
  ...conn,
  ...compliance,
  ...areas,
  ...external,
  ...usecases,
  ...saas,
  ...insights,
  ...billing,
  ...processTexts,
  ...radar,
  ...learning,
  ...importAi,
  ...security,
  ...enterprise,
  ...aieval,
  ...aigw,
} as const;
