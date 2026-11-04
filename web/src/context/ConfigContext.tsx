import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import type { PublicConfig } from '../lib/types';
import { isConfigured } from '../lib/supabase';

const DEFAULTS: PublicConfig = {
  institution_name: 'VISTASEC',
  exam_cell_name: 'Examination Cell (VISTASEC)',
  app_title: 'VISTASEC Invigilator Check-In',
  logo_data_url: null,
  contact_instructions: 'Please contact the VISTASEC examination cell.',
  support_info: null,
};

interface Ctx { config: PublicConfig; loaded: boolean; setConfig: (c: PublicConfig) => void }
const ConfigContext = createContext<Ctx>({ config: DEFAULTS, loaded: false, setConfig: () => undefined });

export function ConfigProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<PublicConfig>(DEFAULTS);
  const [loaded, setLoaded] = useState(() => !isConfigured());

  useEffect(() => {
    if (!isConfigured()) return;
    let alive = true;
    api.publicConfig()
      .then((c) => { if (alive && c) setConfig({ ...DEFAULTS, ...c }); })
      .catch(() => undefined)                 // branding is cosmetic: fall back to defaults
      .finally(() => { if (alive) setLoaded(true); });
    return () => { alive = false; };
  }, []);

  useEffect(() => { document.title = config.app_title; }, [config.app_title]);

  const value = useMemo(() => ({ config, loaded, setConfig }), [config, loaded]);
  return <ConfigContext.Provider value={value}>{children}</ConfigContext.Provider>;
}

export const useConfig = () => useContext(ConfigContext);
