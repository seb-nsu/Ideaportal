import type { MessageKey } from '..';
import { common } from './common';
import { app } from './app';
import { components } from './components';
import { labels } from './labels';
import { admin } from './admin';
import { aiAdmin } from './aiAdmin';
import { elaboration } from './elaboration';
import { meetings } from './meetings';
import { aiExtras } from './aiExtras';
import { aiPanel } from './aiPanel';
import { aiQuality } from './aiQuality';
import { aiEvals } from './aiEvals';
import { aiTransparency } from './aiTransparency';
import { submitAssist } from './submitAssist';
import { ideaDetail } from './ideaDetail';
import { publicPages } from './publicPages';
import { submit } from './submit';
import { login } from './login';
import { account } from './account';
import { challenges } from './challenges';
import { dashboard } from './dashboard';
import { help } from './help';
import { tasks } from './tasks';
import { aiProofs } from './aiProofs';
import { ideas } from './ideas';
import { success } from './success';
import { portfolio } from './portfolio';
import { home } from './home';
import { onboarding } from './onboarding';
import { board } from './board';
import { notifications } from './notifications';
import { steckbrief } from './steckbrief';
import { guarantee } from './guarantee';
import { codetermination } from './codetermination';
import { chat } from './chat';
import { integrations } from './integrations';
import { connectors } from './connectors';
import { identity } from './identity';
import { saml } from './saml';
import { compliance } from './compliance';
import { areas } from './areas';
import { insights } from './insights';
import { saas } from './saas';
import { usecases } from './usecases';
import { external } from './external';
import { billing } from './billing';
import { radar } from './radar';
import { learning } from './learning';
import { aiDashboard } from './aiDashboard';
import { importAssist } from './importAssist';
import { security } from './security';
import { enterprise } from './enterprise';

// English catalogue (R3-22). Keys missing here fall back to German; a test checks completeness.
export const en: Partial<Record<MessageKey, string>> = {
  ...common,
  ...app,
  ...components,
  ...labels,
  ...admin,
  ...aiAdmin,
  ...elaboration,
  ...meetings,
  ...aiExtras,
  ...aiPanel,
  ...aiQuality,
  ...aiEvals,
  ...aiTransparency,
  ...submitAssist,
  ...ideaDetail,
  ...publicPages,
  ...submit,
  ...login,
  ...account,
  ...challenges,
  ...dashboard,
  ...help,
  ...tasks,
  ...aiProofs,
  ...ideas,
  ...success,
  ...portfolio,
  ...home,
  ...onboarding,
  ...board,
  ...notifications,
  ...steckbrief,
  ...guarantee,
  ...codetermination,
  ...chat,
  ...integrations,
  ...connectors,
  ...identity,
  ...saml,
  ...compliance,
  ...areas,
  ...insights,
  ...saas,
  ...usecases,
  ...external,
  ...billing,
  ...radar,
  ...learning,
  ...aiDashboard,
  ...importAssist,
  ...security,
  ...enterprise,
};
