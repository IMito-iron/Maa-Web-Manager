import {createContext,useContext,useEffect,useMemo,useState} from 'react';
import {DEFAULT_LOCALE,JA,LOCALES,LOCALE_LABELS,LOCALE_STORAGE_KEY,detectLocale,translate} from './i18n';
import type {Locale,Params} from './i18n';

interface I18n {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  /** The Chinese source text is the key, and the fallback. */
  t: (text: string, params?: Params) => string;
}

const Context = createContext<I18n>({
  locale: DEFAULT_LOCALE,
  setLocale: () => {},
  t: text => text,
});

export function I18nProvider({children}:{children:React.ReactNode}) {
  const [locale,setLocale]=useState<Locale>(()=>detectLocale(
    typeof localStorage==='undefined'?null:localStorage.getItem(LOCALE_STORAGE_KEY),
    typeof navigator==='undefined'?[]:[...(navigator.languages??[]),navigator.language].filter(Boolean) as string[]));
  useEffect(()=>{
    try { localStorage.setItem(LOCALE_STORAGE_KEY,locale); } catch {}
    document.documentElement.lang = locale==='ja'?'ja':'zh-CN';
  },[locale]);
  const value=useMemo<I18n>(()=>({
    locale,
    setLocale,
    t:(text:string,params?:Params)=>translate(locale,text,params),
  }),[locale]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useI18n() { return useContext(Context); }

/** Chinese first, Japanese second; the choice is remembered per browser. */
export function LocaleSwitch() {
  const {locale,setLocale,t}=useI18n();
  return <div className="lang" role="group" aria-label={t('语言')}>
    {LOCALES.map(candidate=><button key={candidate} type="button" className={candidate===locale?'active':''}
      aria-pressed={candidate===locale} onClick={()=>setLocale(candidate)}>{LOCALE_LABELS[candidate]}</button>)}
  </div>;
}
