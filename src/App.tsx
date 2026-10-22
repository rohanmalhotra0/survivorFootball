import { useEffect, useMemo, useState, useRef, type FormEvent, type ReactNode } from 'react';
import { Activity, ArrowDown, ArrowRight, ArrowUpRight, Bell, Check, CheckCheck, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, Clock3, Copy, Eye, EyeOff, Flag, Flame, Grid2X2, Info, LayoutDashboard, LockKeyhole, LogIn, LogOut, Menu, Plus, Search, Settings2, Shield, ShieldCheck, Sparkles, Target, Trophy, Users, X, Zap } from 'lucide-react';
import { NFL_TEAMS } from '../shared/nfl';
import { NFL_PLAYERS } from '../shared/players';
import { getDemoDashboard } from './demo';
import { ApiError, emptyDashboard, request, fetchDashboard, fetchDemoDashboard } from './api';
import type { Dashboard, Game, Team, User } from './view-model';
import './styles.css';

const teams = NFL_TEAMS as Team[];
const teamById = (id?: string | null) => teams.find(team => team.id === id);
const moneyline = (value?: number | null) => value == null ? '—' : value > 0 ? `+${value}` : String(value);
const probability = (value?: number | null) => value == null ? null : Math.round((value < 0 ? -value / (-value + 100) : 100 / (value + 100)) * 100);
const initials = (name: string) => name.split(' ').slice(0, 2).map(s => s[0]).join('');
const dateLabel = (date: string) => new Intl.DateTimeFormat('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }).format(new Date(date)).replace(':00', '') + ' ET';

function TeamLogo({ team, size = 42 }: { team?: Team; size?: number }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [team?.id]);
  return <span className="team-logo" style={{ width: size, height: size }}>{team && !failed ? <img src={team.logo} alt={`${team.name} logo`} onError={() => setFailed(true)} /> : <Shield size={size * .7} />}</span>;
}

function PlayerImage({ src, name, className = '' }: { src?: string; name: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  const assetBase = import.meta.env.VITE_PLAYER_ASSET_BASE_URL?.replace(/\/+$/, '');
  const imageSrc = assetBase && src?.startsWith('/assets/players/') && src.endsWith('.png') ? `${assetBase}/${src.split('/').at(-1)}` : src;
  return src && !failed ? <img className={className} src={imageSrc} alt={name} loading={className.includes('hero') ? 'eager' : 'lazy'} decoding="async" onError={() => setFailed(true)} /> : <div className={`player-fallback ${className}`} aria-label={`${name} portrait unavailable`}><span>{initials(name)}</span></div>;
}

function Modal({ title, subtitle, children, onClose, wide = false }: { title: string; subtitle?: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const dialogRef = useRef<HTMLElement>(null);
  const openerRef = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previousFocus = openerRef.current;
    const focusable = () => Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]') || []).filter(element => element.getClientRects().length > 0);
    const frame = requestAnimationFrame(() => {
      const firstInput = dialogRef.current?.querySelector<HTMLElement>('input:not(:disabled)');
      (firstInput || focusable()[0] || dialogRef.current)?.focus();
    });
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); }
      if (event.key !== 'Tab') return;
      const controls = focusable();
      const first = controls[0];
      const last = controls.at(-1);
      if (!first) { event.preventDefault(); dialogRef.current?.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    const keepFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !dialogRef.current?.contains(event.target)) (focusable()[0] || dialogRef.current)?.focus();
    };
    document.addEventListener('keydown', handler);
    document.addEventListener('focusin', keepFocus);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { cancelAnimationFrame(frame); document.removeEventListener('keydown', handler); document.removeEventListener('focusin', keepFocus); document.body.style.overflow = previous; previousFocus?.focus(); };
  }, []);
  return <div className="modal-backdrop" onClick={event => { if (event.target === event.currentTarget) onClose(); }}><section ref={dialogRef} tabIndex={-1} className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}><div className="modal-heading"><div><span className="eyebrow">SURVIVOR CLUB</span><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={20} /></button></div>{children}</section></div>;
}

function App() {
  const [dashboard, setDashboard] = useState<Dashboard>(() => getDemoDashboard());
  const [user, setUser] = useState<User | null>(null);
  const [tab, setTab] = useState('Overview');
  const [authMode, setAuthMode] = useState<'login' | 'register' | null>(null);
  const [passwordMode, setPasswordMode] = useState<'request' | 'reset' | null>(null);
  const [passwordRecovery, setPasswordRecovery] = useState(false);
  const [accountServiceUnavailable, setAccountServiceUnavailable] = useState(false);
  const [recoverySession, setRecoverySession] = useState<'checking' | 'ready' | 'expired'>('checking');
  const [leagueMode, setLeagueMode] = useState<'create' | 'join' | null>(null);
  const [pickOpen, setPickOpen] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [leaguePickerOpen, setLeaguePickerOpen] = useState(false);
  const [toast, setToast] = useState('');
  const [pageError, setPageError] = useState('');
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [playerSearch, setPlayerSearch] = useState('');
  const [playerTeam, setPlayerTeam] = useState('all');
  const [playerStatus, setPlayerStatus] = useState('ACT');
  const [playerLimit, setPlayerLimit] = useState(36);
  const [showAllGames, setShowAllGames] = useState(false);

  const callbackRef = useRef(new URL(window.location.href).searchParams.get('auth'));
  const accountRef = useRef<User | null>(null);
  const authRevision = useRef(0);
  const dashboardRevision = useRef(0);
  const dashboardAbort = useRef<AbortController | null>(null);
  const dashboardRef = useRef(dashboard);
  dashboardRef.current = dashboard;

  function invalidateDashboard() {
    dashboardRevision.current++;
    dashboardAbort.current?.abort();
    dashboardAbort.current = null;
  }

  async function loadDashboard(leagueId?: string, week?: number, account = accountRef.current) {
    invalidateDashboard();
    const revision = dashboardRevision.current;
    const sessionRevision = authRevision.current;
    const controller = new AbortController();
    dashboardAbort.current = controller;
    setLoading(true);
    setPageError('');
    const isCurrent = () => !controller.signal.aborted
      && revision === dashboardRevision.current
      && sessionRevision === authRevision.current
      && account?.id === accountRef.current?.id;
    try {
      const result = account
        ? await fetchDashboard(account, leagueId, week, controller.signal)
        : await fetchDemoDashboard(week, controller.signal);
      if (isCurrent()) setDashboard(result);
    } catch (error) {
      if (!isCurrent()) return;
      if (error instanceof ApiError && error.status === 401) {
        authRevision.current++;
        accountRef.current = null;
        setUser(null);
        setDashboard(getDemoDashboard());
        setPickOpen(false);
        setLeagueMode(null);
        setLeaguePickerOpen(false);
        setAuthMode('login');
        setPageError('Your session expired. Sign in again to return to your league.');
      } else {
        setPageError(error instanceof Error ? error.message : 'Unable to load your league.');
      }
    } finally {
      if (revision === dashboardRevision.current) setLoading(false);
    }
  }

  function acceptUser(nextUser: User) {
    authRevision.current++;
    invalidateDashboard();
    accountRef.current = nextUser;
    setUser(nextUser);
    setDashboard(emptyDashboard(nextUser));
    setAuthMode(null);
    void loadDashboard(undefined, undefined, nextUser);
  }

  useEffect(() => {
    const controller = new AbortController();
    const initialAuthRevision = authRevision.current;
    const initialDashboardRevision = dashboardRevision.current;
    let active = true;
    const query = new URL(window.location.href);
    const callback = callbackRef.current;
    if (callback && ['confirmed', 'recovery', 'error'].includes(callback)) {
      query.searchParams.delete('auth');
      window.history.replaceState(null, '', query.pathname + query.search + query.hash);
      if (callback === 'recovery') {
        setPasswordMode('reset');
        setRecoverySession('checking');
      } else if (callback === 'error') {
        setAuthMode('login');
        setPageError('That email link is invalid or expired. Sign in or request a new reset link.');
      }
    }
    void request<{ passwordRecovery?: boolean }>('/api/health', { signal: controller.signal })
      .then(result => { if (active) { setPasswordRecovery(result.passwordRecovery === true); setAccountServiceUnavailable(false); } })
      .catch(error => { if (active && error instanceof ApiError && error.status === 503) setAccountServiceUnavailable(true); });
    void fetchDemoDashboard(undefined, controller.signal).then(result => {
      if (active && authRevision.current === initialAuthRevision && dashboardRevision.current === initialDashboardRevision && !accountRef.current) setDashboard(result);
    }).catch(() => {});
    void request<{ user: User | null }>('/api/auth/me', { signal: controller.signal }).then(result => {
      if (!active || initialAuthRevision !== authRevision.current) return;
      if (result.user) acceptUser(result.user);
      if (callback === 'recovery') setRecoverySession(result.user ? 'ready' : 'expired');
      if (callback === 'confirmed') {
        setToast(result.user ? 'Email confirmed. Welcome to your club.' : 'Email confirmed. Sign in to continue.');
        if (!result.user) setAuthMode('login');
      }
    }).catch(() => {
      if (active && callback === 'recovery') setRecoverySession('expired');
    });
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => { active = false; controller.abort(); clearInterval(timer); };
  }, []);

  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 4500); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => {
    if (dashboard.demo || !user) return;
    const timer = setInterval(() => { void loadDashboard(dashboard.league?.id, dashboard.week); }, 30_000);
    return () => clearInterval(timer);
  }, [dashboard.demo, dashboard.league?.id, dashboard.week, user]);
  useEffect(() => {
    if (dashboard.picksRevealed || !dashboard.league) return;
    const delay = Date.parse(dashboard.revealAt) - Date.now();
    if (!Number.isFinite(delay) || delay > 2_147_000_000) return;
    // Ask the server at the boundary; the browser never unmasks cached private picks.
    const timer = setTimeout(() => { void loadDashboard(dashboard.league?.id, dashboard.week, user); }, Math.max(100, delay + 100));
    return () => clearTimeout(timer);
  }, [dashboard.revealAt, dashboard.picksRevealed, dashboard.league?.id, dashboard.week, user?.id]);

  const activeMembers = dashboard.members.filter(member => member.status === 'active' || member.status === 'winner');
  const pickedMembers = dashboard.picksRevealed ? dashboard.members.filter(member => member.pick?.teamId).length : activeMembers.length;
  const myPickTeam = teamById(dashboard.myPick?.teamId);
  const myGame = dashboard.games.find(game => game.homeTeamId === myPickTeam?.id || game.awayTeamId === myPickTeam?.id);
  const myMember = dashboard.members.find(member => member.isYou || member.id === user?.id);
  const myEliminated = myMember?.status === 'eliminated';
  const myWinner = myMember?.status === 'winner';
  const secondsUntilReveal = Math.max(0, Math.floor((new Date(dashboard.revealAt).getTime() - now) / 1000));
  const countdown = `${Math.floor(secondsUntilReveal / 3600).toString().padStart(2, '0')}:${Math.floor(secondsUntilReveal % 3600 / 60).toString().padStart(2, '0')}:${(secondsUntilReveal % 60).toString().padStart(2, '0')}`;
  const heroPlayer = NFL_PLAYERS.find(player => player.name.toLowerCase().includes('mahomes')) || NFL_PLAYERS.find(player => player.position === 'QB');
  const filteredPlayers = useMemo(() => NFL_PLAYERS.filter(player => (playerStatus === 'all' || player.status === playerStatus) && (playerTeam === 'all' || player.teamId === playerTeam) && `${player.name} ${player.position} ${teamById(player.teamId)?.name}`.toLowerCase().includes(playerSearch.toLowerCase())), [playerSearch, playerTeam, playerStatus]);

  function navigate(nextTab: string) { setTab(nextTab); setMobileNav(false); }
  function openLeague(mode: 'create' | 'join') { if (!user) { setAuthMode('register'); return; } setLeagueMode(mode); }
  async function logout() {
    authRevision.current++;
    const revision = authRevision.current;
    invalidateDashboard();
    try {
      await request('/api/auth/logout', { method: 'POST' });
      if (revision !== authRevision.current) return;
      accountRef.current = null;
      setUser(null);
      setDashboard(getDemoDashboard());
      setPickOpen(false);
      setLeagueMode(null);
      setLeaguePickerOpen(false);
      void loadDashboard(undefined, undefined, null);
      setToast('You have been signed out.');
    } catch (error) {
      if (revision === authRevision.current) {
        setToast(error instanceof Error ? error.message : 'Unable to sign out. Please try again.');
        setLoading(false);
      }
    }
  }
  async function copyInvite() {
    if (dashboard.demo) { setAuthMode('register'); return; }
    if (!dashboard.league?.inviteCode) return;
    try { await navigator.clipboard.writeText(dashboard.league.inviteCode); setToast('Invite code copied. Share it with your friends.'); }
    catch { setToast(`League invite code: ${dashboard.league.inviteCode}`); }
  }
  async function changeWeek(delta: number) {
    const week = Math.min(18, Math.max(1, dashboard.week + delta));
    void loadDashboard(dashboard.league?.id, week);
  }

  return <div className="app-shell">
    {mobileNav && <div className="nav-overlay" onClick={() => setMobileNav(false)} />}
    <aside className={`sidebar ${mobileNav ? 'is-open' : ''}`}>
      <button className="brand" onClick={() => navigate('Overview')} aria-label="Survivor Club home"><span className="brand-mark"><ShieldCheck size={26} strokeWidth={2.3} /></span><span>SURVIVOR<span className="brand-second">CLUB</span></span></button>
      <div className="league-switcher"><div className="league-avatar"><Trophy size={20} /></div><div><span className="small-label">YOUR LEAGUE</span><strong>{dashboard.league?.name || 'Find your people'}</strong></div><button className="icon-button" aria-label="Manage leagues" onClick={() => user ? setLeaguePickerOpen(!leaguePickerOpen) : setAuthMode('register')} aria-expanded={leaguePickerOpen}><ChevronDown size={16} /></button></div>{leaguePickerOpen && <div className="league-popover"><span className="small-label">SWITCH LEAGUE</span>{dashboard.leagues.map(league => <button key={league.id} className={dashboard.league?.id === league.id ? 'selected' : ''} onClick={() => { setLeaguePickerOpen(false); void loadDashboard(league.id); }}><Trophy size={13} /><span>{league.name}</span>{league.id === dashboard.league?.id && <Check size={12} />}</button>)}<button onClick={() => { setLeaguePickerOpen(false); openLeague('create'); }}><Plus size={13} />Create a league</button><button onClick={() => { setLeaguePickerOpen(false); openLeague('join'); }}><Users size={13} />Join with a code</button></div>}
      <div className="nav-label">THE PLAYBOOK</div>
      <nav aria-label="Main navigation">{[
        ['Overview', LayoutDashboard], ['My picks', Target], ['Standings', Trophy], ['Players', Users],
      ].map(([name, Icon]) => { const NavIcon = Icon as typeof LayoutDashboard; return <button key={String(name)} className={`nav-item ${tab === name ? 'active' : ''}`} onClick={() => navigate(String(name))}><NavIcon size={19} /><span>{String(name)}</span>{name === 'My picks' && <span className="nav-counter">{dashboard.myPicks.length}</span>}{tab === name && <span className="active-dot" />}</button>; })}</nav>
      <div className="sidebar-divider" />
      <div className="nav-label">YOUR LEAGUE</div>
      <button className="nav-item" onClick={copyInvite}><Users size={19} /><span>Invite friends</span><ArrowUpRight size={14} /></button>
      <button className="nav-item" onClick={() => setRulesOpen(true)}><Shield size={19} /><span>League rules</span></button>
      <button className="nav-item" onClick={() => openLeague('create')}><Plus size={19} /><span>Create a league</span></button>
      <div className="sidebar-bottom"><div className="survival-note"><span className="mini-flame"><Flame size={18} /></span><h3>ONE PICK.<br />ALL THE GLORY.</h3><p>Football is a game of inches.<br />Survivor is a game of instinct.</p><button onClick={() => setRulesOpen(true)}>How to play <ArrowUpRight size={14} /></button></div><button className="user-menu" onClick={() => user ? void logout() : setAuthMode('login')}><span className="avatar">{initials(user?.name || 'Guest Player')}</span><span><strong>{user?.name || 'Guest player'}</strong><small>{user ? 'Sign out' : 'Sign in to play'}</small></span>{user ? <LogOut size={17} /> : <LogIn size={17} />}</button></div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><div className="breadcrumb"><button className="icon-button mobile-menu" aria-label="Open navigation" onClick={() => setMobileNav(true)}><Menu size={21} /></button><span>Football</span><ChevronRight size={14} /><strong>Survivor</strong><span className="season-chip">{dashboard.season} SEASON</span></div><div className="topbar-actions"><span className="private-label"><LockKeyhole size={13} /> Private league</span>{user ? <button className="top-avatar" onClick={() => setToast(`Signed in as ${user.email}`)} aria-label="Account details">{initials(user.name)}</button> : <button className="button button-small button-outline" onClick={() => setAuthMode('login')}>Sign in <ArrowUpRight size={14} /></button>}</div></header>
      <main className="main-content">
        {dashboard.demo && <div className="preview-banner"><span><Sparkles size={14} /><strong>Take a look around.</strong><span>{dashboard.dataSource === 'Interactive preview' ? 'Sample league, games and odds.' : 'Sample league. Real NFL schedule and available odds.'}</span></span><button onClick={() => setAuthMode('register')}>Start your league <ArrowRight size={14} /></button></div>}
        {accountServiceUnavailable && <div className="data-warning" role="status"><Info size={14} /><span>Account services aren’t ready yet. You can explore the demo while the site owner finishes the hosting setup.</span></div>}
        {dashboard.dataWarning && !dashboard.demo && <div className="data-warning"><Clock3 size={14} /><span>{dashboard.dataWarning}</span></div>}
        {pageError && <div className="error-banner" role="alert"><Info size={17} />{pageError}<button onClick={() => void loadDashboard(dashboard.league?.id)}>Retry</button></div>}
        <div className="page-heading"><div><div className="eyebrow"><span className="green-dot" /> {dashboard.league?.name || 'YOUR NEXT SUNDAY STARTS HERE'}</div><h1>{tab === 'Overview' ? 'EVERY PICK COUNTS.' : tab === 'My picks' ? 'YOUR SURVIVAL STORY.' : tab === 'Standings' ? 'LAST ONE STANDING.' : 'THE PLAYMAKERS.'}</h1><p>{tab === 'Overview' ? 'One team. One shot. Another week in the game.' : tab === 'My picks' ? 'Build your streak. Choose wisely. There are no second chances.' : tab === 'Standings' ? 'The field gets smaller. The stakes get bigger.' : 'The names behind the game. Explore NFL rosters.'}</p></div><div className="week-selector"><button disabled={dashboard.week <= 1 || loading} onClick={() => changeWeek(-1)} aria-label="Previous week"><ChevronLeft size={16} /></button><span><small>REGULAR SEASON</small><strong>Week {dashboard.week}<ChevronDown size={14} /></strong></span><button disabled={dashboard.week >= 18 || loading} onClick={() => changeWeek(1)} aria-label="Next week"><ChevronRight size={16} /></button></div></div>
        {user && !dashboard.league && <div className="empty-league panel"><div className="empty-icon"><Flag size={30} /></div><h2>Your people. Your league.</h2><p>Create a private survivor league or enter an invite code to join your friends.</p><div><button className="button button-green" onClick={() => setLeagueMode('create')}><Plus size={17} />Create a league</button><button className="button button-outline" onClick={() => setLeagueMode('join')}>Join with a code</button></div></div>}
        {(dashboard.league || dashboard.demo) && <>
          <div className="stats-grid">
            <Stat label="STILL IN THE GAME" value={String(activeMembers.length).padStart(2, '0')} suffix={`/ ${dashboard.members.length}`} icon={<Users size={18} />} footer={<><span className="green-text">{dashboard.members.length ? Math.round(activeMembers.length / dashboard.members.length * 100) : 0}%</span> of the field survives</>} />
            <Stat label="YOUR WIN STREAK" value={String(dashboard.myPicks.filter(pick => pick.result === 'won').length).padStart(2, '0')} suffix="weeks" icon={<Flame size={18} />} footer={<><span className="green-text"><ArrowUpRight size={13} /> {myEliminated ? 'Run complete' : 'Keep it going'}</span><span className="mini-streak">{Array.from({ length: 7 }, (_, i) => <i className={i < dashboard.myPicks.filter(p => p.result === 'won').length ? 'lit' : ''} key={i} />)}</span></>} />
            <Stat label="TEAMS AVAILABLE" value={String(32 - dashboard.usedTeamIds.length).padStart(2, '0')} suffix="/ 32" icon={<Shield size={18} />} footer={<>{dashboard.usedTeamIds.length} used · make the next one count</>} />
            <Stat label={dashboard.picksRevealed ? 'PICKS ARE REVEALED' : 'THE REVEAL COUNTDOWN'} value={dashboard.picksRevealed ? 'GAME ON' : countdown} icon={dashboard.picksRevealed ? <Eye size={18} /> : <Clock3 size={18} />} compact footer={<><span className="tiny-dot" /> Sunday · 1:00 PM New York time</>} />
          </div>
          {tab === 'Overview' && <>
            <div className="dashboard-grid">
              <section className="pick-hero"><div className="hero-grid" /><div className="hero-number">15</div>{heroPlayer && <PlayerImage className="hero-player" src={heroPlayer.headshot} name={heroPlayer.name} />}<div className="hero-image-shade" /><div className="hero-content"><div className="hero-kicker"><span className="hero-live-dot" /> WEEK {dashboard.week} · YOUR SURVIVOR PICK</div><h2>{myPickTeam ? <>INSTINCT.<br />LOCKED IN.</> : <>TRUST YOUR<br />INSTINCT.</>}</h2><p>{myPickTeam ? `You've backed ${myPickTeam.city}. Now let the game do the talking.` : 'The safe bet? The bold move? Your season comes down to one decision.'}</p>{myPickTeam && <div className="hero-selection"><TeamLogo team={myPickTeam} size={37} /><span><strong>{myPickTeam.name}</strong><small><LockKeyhole size={11} /> {dashboard.picksRevealed ? 'Your pick is now revealed' : 'Only you can see this pick'}</small></span><CheckCircle2 size={18} /></div>}<button className="button button-green hero-cta" disabled={myEliminated || myWinner} onClick={() => setPickOpen(true)}>{myWinner ? 'League champion' : myEliminated ? 'Your run has ended' : myPickTeam ? 'Review your pick' : 'Make your pick'}<ArrowUpRight size={18} /></button><div className="hero-bottom"><ShieldCheck size={14} /> {dashboard.picksRevealed ? 'This week’s picks have been revealed' : myPickTeam ? 'Pick saved securely' : 'Your pick stays private until the reveal'}</div></div><span className="hero-credit">{heroPlayer?.name || 'NFL'} <span>QB · KANSAS CITY</span></span></section>
              <section className="panel league-pulse"><div className="section-heading"><div><span className="eyebrow">THE ROOM IS GETTING QUIETER</span><h2>League pulse</h2></div><Activity size={20} /></div><div className="pulse-number"><strong>{pickedMembers.toString().padStart(2, '0')}</strong><span>{dashboard.picksRevealed ? <>of {activeMembers.length} survivors<br />have revealed their pick</> : <>survivors. Every choice<br />stays under wraps.</>}</span></div><div className="progress-track"><span style={{ width: `${Math.min(100, pickedMembers / Math.max(activeMembers.length, 1) * 100)}%` }} /></div><div className="pulse-status"><span><i /> {dashboard.picksRevealed ? `${pickedMembers} revealed` : 'Selections stay private'}</span><span>{dashboard.picksRevealed ? 'Reveal complete' : 'No early access'}</span></div><div className="sealed-note"><span className="sealed-icon"><LockKeyhole size={21} /></span><div><strong>{dashboard.picksRevealed ? 'The picks are out.' : 'Poker faces, everyone.'}</strong><p>{dashboard.picksRevealed ? 'See who backed whom in the standings.' : 'All picks stay sealed until Sunday at 1 p.m. New York time.'}</p></div></div><button className="text-link" onClick={() => navigate('Standings')}>See the competition <ArrowRight size={16} /></button></section>
            </div>
            <div className="content-section"><div className="section-title"><div><span className="eyebrow">FIND YOUR EDGE</span><h2>This week’s matchups<span>{dashboard.games.length} GAMES</span></h2></div><button className="text-link" onClick={() => setShowAllGames(!showAllGames)}>{showAllGames ? 'Show less' : 'All matchups'}<ArrowRight size={15} /></button></div><div className="odds-note"><Info size={12} />{dashboard.dataSource === 'Interactive preview' ? 'Illustrative odds · sample matchups for preview only' : dashboard.oddsUpdatedAt ? `${dashboard.dataSource || 'NFL feed'} · odds retrieved ${new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York', timeZoneName: 'short' }).format(new Date(dashboard.oddsUpdatedAt))} · implied probabilities include bookmaker margin` : 'Odds will appear when available from a connected provider.'}</div><div className="matchup-grid">{dashboard.games.slice(0, showAllGames ? undefined : 3).map(game => <MatchupCard key={game.id} game={game} usedTeamIds={dashboard.usedTeamIds} onPick={() => setPickOpen(true)} />)}</div>{dashboard.games.length === 0 && <div className="panel empty-inline"><Clock3 size={23} /><h3>No scheduled games for this week yet.</h3><p>Schedule updates happen automatically when the NFL data provider is available.</p></div>}</div>
            <div className="bottom-grid"><section className="panel contenders-panel"><div className="section-heading"><h2>The contenders</h2><button className="text-link" onClick={() => navigate('Standings')}>Full standings<ArrowUpRight size={14} /></button></div><MembersTable dashboard={dashboard} limit={4} /></section><section className="strategy-card"><div className="strategy-icon"><Zap size={23} /></div><span className="eyebrow">PLAY THE LONG GAME</span><h2>YOUR FAVORITE<br />ISN’T ALWAYS<br />YOUR BEST PICK.</h2><p>You can only use a team once. Keep an eye on future matchups before you burn a contender.</p><button className="text-link" onClick={() => setRulesOpen(true)}>Know the game<ArrowUpRight size={15} /></button><span className="strategy-art">↗</span></section></div>
          </>}
          {tab === 'My picks' && <div className="content-section"><div className="section-title"><div><span className="eyebrow">ONE WEEK AT A TIME</span><h2>Your season so far</h2></div><button className="button button-green" disabled={myEliminated || myWinner} onClick={() => setPickOpen(true)}>{myPickTeam ? 'Review pick' : 'Make a pick'}<ArrowUpRight size={16} /></button></div><div className="pick-history">{[...dashboard.myPicks].sort((a, b) => b.week - a.week).map(pick => { const team = teamById(pick.teamId); return <div className="history-row panel" key={pick.week}><div className="history-week"><small>WEEK</small><strong>{String(pick.week).padStart(2, '0')}</strong></div><TeamLogo team={team} size={52} /><div className="history-team"><strong>{team?.name || pick.teamId}</strong><span>{team?.city} · {dashboard.season} regular season</span></div><span className={`status-badge ${pick.result === 'won' ? 'success' : pick.result === 'lost' ? 'danger' : ''}`}>{pick.result === 'won' ? <CheckCircle2 size={14} /> : <Clock3 size={14} />}{pick.result === 'won' ? 'SURVIVED' : pick.result === 'lost' ? 'ELIMINATED' : 'PENDING'}</span></div>; })}{dashboard.myPicks.length === 0 && <div className="panel empty-inline"><Target size={28} /><h3>Your story starts with one pick.</h3><p>Choose a team this week to begin your survivor run.</p></div>}</div><div className="used-team-panel panel"><h3>Your remaining playbook</h3><p>Dimmed teams have already been used. Every other team is still an option when scheduled.</p><div className="used-team-grid">{teams.map(team => <div className={dashboard.usedTeamIds.includes(team.id) ? 'used' : ''} key={team.id}><TeamLogo team={team} size={36} /><span>{team.abbreviation}</span>{dashboard.usedTeamIds.includes(team.id) && <Check size={12} />}</div>)}</div></div></div>}
          {tab === 'Standings' && <section className="panel standings-panel"><div className="section-heading"><div><span className="eyebrow">THE SUNDAY CLUBHOUSE</span><h2>Everyone’s chasing the same thing.</h2></div><button className="button button-outline button-small" onClick={copyInvite}><Users size={14} />Invite friends</button></div><div className="standings-notice"><ShieldCheck size={18} /><span>{dashboard.picksRevealed ? 'The reveal is here. This week’s picks are visible to all league members.' : 'Picks are private until Sunday at 1 p.m. New York time. Not even the commissioner gets an early look.'}</span></div><MembersTable dashboard={dashboard} /></section>}
        </>}
        {tab === 'Players' && <section className="content-section"><div className="players-toolbar"><label className="search-input"><Search size={18} /><input placeholder="Search players, positions, teams…" value={playerSearch} onChange={event => { setPlayerSearch(event.target.value); setPlayerLimit(36); }} aria-label="Search players" /></label><select className="select-input" aria-label="Filter players by team" value={playerTeam} onChange={event => { setPlayerTeam(event.target.value); setPlayerLimit(36); }}><option value="all">All 32 teams</option>{teams.map(team => <option value={team.id} key={team.id}>{team.name}</option>)}</select><select className="select-input player-status-filter" aria-label="Filter players by roster status" value={playerStatus} onChange={event => { setPlayerStatus(event.target.value); setPlayerLimit(36); }}><option value="ACT">Active roster</option><option value="all">All roster records</option><option value="DEV">Practice squad</option><option value="RES">Reserve</option><option value="CUT">Released</option></select><span className="results-count">{filteredPlayers.length} players</span></div><div className="players-explainer"><Info size={14} />Scout the faces behind the teams. In survivor, you pick a winning NFL team each week—not individual players.</div><div className="players-grid">{filteredPlayers.slice(0, playerLimit).map(player => { const team = teamById(player.teamId); return <article className="player-card" key={`${player.teamId}-${player.id}`} style={{ '--team-color': team?.color ? `#${team.color.replace('#', '')}` : '#c9f65b' } as React.CSSProperties}><div className="player-card-top"><TeamLogo team={team} size={30} /><span>{player.position}<i>#{player.jersey || '—'}</i></span></div><div className="player-photo-wrap"><span className="player-jersey">{player.jersey || 'NFL'}</span><PlayerImage src={player.headshot} name={player.name} /></div><div className="player-card-info"><small>{team?.name || 'NFL PLAYER'}</small><h3>{player.name}</h3></div></article>; })}</div>{!filteredPlayers.length && <div className="panel empty-inline"><Search size={28} /><h3>No players found.</h3><p>Try another name, position, or team.</p></div>}{filteredPlayers.length > playerLimit && <div className="load-more"><button className="button button-outline" onClick={() => setPlayerLimit(playerLimit + 36)}>Show more players<ChevronDown size={16} /></button></div>}</section>}
        <footer className="page-footer"><div className="footer-brand"><ShieldCheck size={16} />SURVIVOR CLUB<span>Built for the last one standing.</span></div><button onClick={() => setRulesOpen(true)}>Rules & fair play<ArrowUpRight size={12} /></button></footer>
      </main>
    </div>
    {authMode && <AuthModal mode={authMode} setMode={setAuthMode} passwordRecovery={passwordRecovery} onForgot={() => { setAuthMode(null); setPasswordMode('request'); }} onClose={() => setAuthMode(null)} onSuccess={nextUser => { acceptUser(nextUser); setToast('You’re in. Let’s build your season.'); }} />}
    {passwordMode && <PasswordModal mode={passwordMode} recoverySession={recoverySession} onClose={() => setPasswordMode(null)} onRequestNew={() => setPasswordMode('request')} onSuccess={async () => {
      setPasswordMode(null);
      setToast('Your password has been updated.');
      const revision = authRevision.current;
      const result = await request<{ user: User | null }>('/api/auth/me');
      if (revision !== authRevision.current) return;
      if (result.user) acceptUser(result.user);
      else setAuthMode('login');
    }} />}
    {leagueMode && <LeagueModal mode={leagueMode} setMode={setLeagueMode} onClose={() => setLeagueMode(null)} onSuccess={leagueId => { setLeagueMode(null); void loadDashboard(leagueId); setToast(leagueMode === 'create' ? 'Your league is ready. Invite your people.' : 'Welcome to the league.'); }} />}
    {pickOpen && <PickModal dashboard={dashboard} onClose={() => setPickOpen(false)} onSave={async teamId => {
      if (dashboard.demo) { const pick = { week: dashboard.week, teamId, result: 'pending' }; setDashboard(previous => ({ ...previous, myPick: pick, myPicks: [...previous.myPicks.filter(p => p.week !== previous.week), pick], members: previous.members.map(member => member.isYou ? { ...member, pick: { teamId, submitted: true, hidden: false } } : member) })); setToast('Preview pick saved. Create an account to play for real.'); }
      else { await request(`/api/leagues/${dashboard.league?.id}/picks`, { method: 'POST', body: JSON.stringify({ teamId, week: dashboard.week }) }); await loadDashboard(dashboard.league?.id, dashboard.week); setToast('Pick saved. Your choice stays private until Sunday’s reveal.'); }
      setPickOpen(false);
    }} />}
    {rulesOpen && <RulesModal onClose={() => setRulesOpen(false)} />}
    {toast && <div className="toast" role="status"><CheckCircle2 size={18} /><span>{toast}</span><button aria-label="Dismiss notification" onClick={() => setToast('')}><X size={15} /></button></div>}
  </div>;
}

function Stat({ label, value, suffix, icon, footer, compact }: { label: string; value: string; suffix?: string; icon: ReactNode; footer: ReactNode; compact?: boolean }) {
  return <div className={`stat-card ${compact ? 'stat-timer' : ''}`}><div className="stat-top"><span>{label}</span>{icon}</div><div className="stat-value">{value}<span>{suffix}</span></div><div className="stat-footer">{footer}</div></div>;
}

function MatchupCard({ game, usedTeamIds, onPick }: { game: Game; usedTeamIds: string[]; onPick: () => void }) {
  const home = teamById(game.homeTeamId), away = teamById(game.awayTeamId);
  const homeProbability = probability(game.odds?.homeMoneyline), awayProbability = probability(game.odds?.awayMoneyline);
  return <article className="matchup-card"><div className="matchup-meta"><span><span className="tiny-dot" />{dateLabel(game.kickoff)}</span><span>{game.status === 'final' ? 'FINAL' : game.status === 'in_progress' ? 'LIVE' : 'NFL'}</span></div><div className="matchup-team-row"><TeamLogo team={away} size={39} /><span><strong>{away?.abbreviation || game.awayTeamId}</strong><small>{away?.city}</small></span>{usedTeamIds.includes(game.awayTeamId) && <span className="used-label">USED</span>}<strong className="matchup-odds">{game.status === 'final' ? game.awayScore : moneyline(game.odds?.awayMoneyline)}</strong></div><div className="matchup-team-row"><TeamLogo team={home} size={39} /><span><strong>{home?.abbreviation || game.homeTeamId}</strong><small>{home?.city}</small></span>{usedTeamIds.includes(game.homeTeamId) && <span className="used-label">USED</span>}<strong className="matchup-odds">{game.status === 'final' ? game.homeScore : moneyline(game.odds?.homeMoneyline)}</strong></div><div className="matchup-bottom"><span>{homeProbability != null && awayProbability != null ? <><i className="probability-dot" />{homeProbability >= awayProbability ? home?.abbreviation : away?.abbreviation} <strong>{Math.max(homeProbability, awayProbability)}%</strong> implied win chance</> : 'Moneyline unavailable'}</span><button aria-label={`Choose a team for ${away?.name} at ${home?.name}`} onClick={onPick}><ArrowUpRight size={17} /></button></div></article>;
}

function MembersTable({ dashboard, limit }: { dashboard: Dashboard; limit?: number }) {
  return <div className="table-scroll"><table className="members-table"><thead><tr><th>#</th><th>PLAYER</th><th>STATUS</th><th>WEEK {dashboard.week} PICK</th></tr></thead><tbody>{dashboard.members.slice(0, limit).map((member, index) => { const visibleTeam = teamById(member.pick?.teamId); return <tr key={member.id}><td className="rank">{String(index + 1).padStart(2, '0')}</td><td><div className="table-user"><span className={`avatar avatar-${index % 4}`}>{initials(member.name)}</span><strong>{member.name}</strong>{member.isYou && <span className="you-badge">YOU</span>}</div></td><td><span className={`member-status ${member.status === 'active' || member.status === 'winner' ? 'active-status' : 'out-status'}`}><i />{member.status === 'winner' ? 'Champion' : member.status === 'active' ? 'Surviving' : 'Eliminated'}</span></td><td>{visibleTeam && (!member.pick?.hidden || member.isYou) ? <span className="revealed-pick"><TeamLogo team={visibleTeam} size={24} />{visibleTeam.abbreviation}</span> : member.status === 'eliminated' ? <span className="muted">—</span> : <span className="hidden-pick">{member.pick?.hidden || member.pick?.submitted ? <LockKeyhole size={13} /> : <Clock3 size={13} />}{member.pick?.hidden ? 'Pick sealed' : member.pick?.submitted ? 'Pick submitted' : 'Yet to pick'}</span>}</td></tr>; })}</tbody></table></div>;
}

function AuthModal({ mode, setMode, onClose, onSuccess, passwordRecovery, onForgot }: {
  mode: 'login' | 'register';
  setMode: (mode: 'login' | 'register') => void;
  onClose: () => void;
  onSuccess: (user: User) => void;
  passwordRecovery: boolean;
  onForgot: () => void;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmationSent, setConfirmationSent] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await request<{ user: User | null; confirmationRequired?: boolean }>(`/api/auth/${mode}`, {
        method: 'POST',
        body: JSON.stringify({ name, email, password }),
      });
      setPassword('');
      if (mode === 'register' && result.confirmationRequired) {
        setConfirmationSent(true);
      } else if (result.user) {
        onSuccess(result.user);
      } else {
        setError('Unable to complete sign-in. Please try again.');
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Unable to sign in.');
    } finally {
      setBusy(false);
    }
  }

  function changeMode(next: 'login' | 'register') {
    setMode(next);
    setError('');
    setPassword('');
    setConfirmationSent(false);
  }

  if (confirmationSent) {
    return <Modal title="CHECK YOUR INBOX." subtitle="One more step before kickoff." onClose={onClose}>
      <div className="auth-message" role="status">
        <ShieldCheck size={28} />
        <h3>Confirm your email</h3>
        <p>Check <strong>{email}</strong> for a confirmation link. Open it in this browser to finish creating your account.</p>
        <p>You can sign in after confirmation. Check your spam folder if the message hasn’t arrived.</p>
      </div>
      <button className="button button-green button-full" onClick={() => changeMode('login')}>Back to sign in<ArrowRight size={17} /></button>
    </Modal>;
  }

  return <Modal
    title={mode === 'register' ? 'GET IN THE GAME.' : 'WELCOME BACK.'}
    subtitle={mode === 'register' ? 'Your next great Sunday starts right here.' : 'Your league is waiting. Make your next move.'}
    onClose={() => { if (!busy) onClose(); }}
  >
    <div className="modal-tabs">
      <button disabled={busy} className={mode === 'register' ? 'active' : ''} onClick={() => changeMode('register')}>Create account</button>
      <button disabled={busy} className={mode === 'login' ? 'active' : ''} onClick={() => changeMode('login')}>Sign in</button>
    </div>
    <form className="form-stack" onSubmit={submit}>
      {mode === 'register' && <label>Display name<input autoFocus disabled={busy} value={name} onChange={event => setName(event.target.value)} required minLength={2} maxLength={40} autoComplete="nickname" placeholder="What should your rivals call you?" /></label>}
      <label>Email address<input autoFocus={mode === 'login'} disabled={busy} value={email} onChange={event => setEmail(event.target.value)} required type="email" maxLength={254} autoComplete="email" placeholder="you@example.com" /></label>
      <label>Password<div className="password-input">
        <input disabled={busy} value={password} onChange={event => setPassword(event.target.value)} required minLength={mode === 'register' ? 12 : 1} maxLength={128} type={visible ? 'text' : 'password'} autoComplete={mode === 'register' ? 'new-password' : 'current-password'} placeholder={mode === 'register' ? 'At least 12 characters' : 'Your password'} />
        <button type="button" onClick={() => setVisible(!visible)} aria-label={visible ? 'Hide password' : 'Show password'}>{visible ? <EyeOff size={18} /> : <Eye size={18} />}</button>
      </div></label>
      {mode === 'login' && passwordRecovery && <button type="button" className="form-link" onClick={onForgot} disabled={busy}>Forgot password?</button>}
      {error && <div className="form-error" role="alert">{error}</div>}
      <button className="button button-green button-full" disabled={busy}>{busy ? 'One moment…' : mode === 'register' ? 'Create your account' : 'Sign in'}<ArrowRight size={17} /></button>
      <p className="form-footnote"><ShieldCheck size={14} />Private leagues. Secure picks. Bragging rights only.</p>
    </form>
  </Modal>;
}

function PasswordModal({ mode, recoverySession, onClose, onRequestNew, onSuccess }: {
  mode: 'request' | 'reset';
  recoverySession: 'checking' | 'ready' | 'expired';
  onClose: () => void;
  onRequestNew: () => void;
  onSuccess: () => Promise<void>;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    if (mode === 'reset' && password !== confirmation) {
      setError('Your passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      if (mode === 'request') {
        await request('/api/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) });
        setSent(true);
      } else {
        await request('/api/auth/reset-password', { method: 'POST', body: JSON.stringify({ password }) });
        setPassword('');
        setConfirmation('');
        await onSuccess();
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Unable to update your password. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return <Modal
    title={mode === 'request' ? 'GET BACK IN THE GAME.' : 'A FRESH START.'}
    subtitle={mode === 'request' ? 'We’ll help you return to your league.' : 'Choose a new password for your account.'}
    onClose={() => { if (!busy) onClose(); }}
  >
    {sent ? <div className="auth-message" role="status">
      <ShieldCheck size={28} /><h3>Check your inbox</h3>
      <p>If an account exists for <strong>{email}</strong>, you’ll receive a password-reset link. Open it in this browser.</p>
      <p>Check your spam folder, then try again later if the message hasn’t arrived.</p>
      <button className="button button-outline button-full" onClick={onClose}>Done</button>
    </div> : mode === 'reset' && recoverySession !== 'ready' ? <div className="auth-message" role="status">
      {recoverySession === 'checking' ? <><Clock3 size={28} /><h3>Checking your reset link…</h3></> : <>
        <LockKeyhole size={28} /><h3>This link is no longer available</h3>
        <p>Your link may have expired or been opened in a different browser. Request a new link to reset your password.</p>
        <button className="button button-green button-full" onClick={onRequestNew}>Request a new link<ArrowRight size={17} /></button>
      </>}
    </div> : <form className="form-stack" onSubmit={submit}>
      {mode === 'request' ? <label>Email address<input autoFocus disabled={busy} type="email" required maxLength={254} autoComplete="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="you@example.com" /></label> : <>
        <label>New password<input autoFocus disabled={busy} type="password" required minLength={12} maxLength={128} autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} placeholder="At least 12 characters" /></label>
        <label>Confirm new password<input disabled={busy} type="password" required minLength={12} maxLength={128} autoComplete="new-password" value={confirmation} onChange={event => setConfirmation(event.target.value)} placeholder="Enter your new password again" /></label>
      </>}
      {error && <div className="form-error" role="alert">{error}</div>}
      <button className="button button-green button-full" disabled={busy}>{busy ? 'One moment…' : mode === 'request' ? 'Send reset link' : 'Save new password'}<ArrowRight size={17} /></button>
    </form>}
  </Modal>;
}

function LeagueModal({ mode, setMode, onClose, onSuccess }: { mode: 'create' | 'join'; setMode: (mode: 'create' | 'join') => void; onClose: () => void; onSuccess: (id: string) => void }) {
  const [value, setValue] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function submit(event: FormEvent) { event.preventDefault(); setBusy(true); setError(''); try { const result = await request<{ league?: { id: string }; id?: string }>(mode === 'create' ? '/api/leagues' : '/api/leagues/join', { method: 'POST', body: JSON.stringify(mode === 'create' ? { name: value } : { inviteCode: value.trim() }) }); onSuccess(result.league?.id || result.id || ''); } catch (error) { setError(error instanceof Error ? error.message : 'Unable to update your league.'); } finally { setBusy(false); } }
  return <Modal title={mode === 'create' ? 'BUILD YOUR CLUB.' : 'FIND YOUR PEOPLE.'} subtitle="A private league. A season of Sundays. One survivor." onClose={onClose}><div className="modal-tabs"><button className={mode === 'create' ? 'active' : ''} onClick={() => { setMode('create'); setValue(''); setError(''); }}>Create a league</button><button className={mode === 'join' ? 'active' : ''} onClick={() => { setMode('join'); setValue(''); setError(''); }}>Join a league</button></div><form className="form-stack" onSubmit={submit}><label>{mode === 'create' ? 'League name' : 'Invite code'}<input autoFocus value={value} onChange={event => setValue(event.target.value)} required minLength={mode === 'create' ? 3 : 4} maxLength={60} placeholder={mode === 'create' ? 'e.g. The Sunday Club' : 'Enter the code from your commissioner'} /></label>{mode === 'create' && <div className="league-rules-preview"><span><Check size={15} />One team per week. No repeats.</span><span><Check size={15} />One loss and you’re out.</span><span><Check size={15} />Picks revealed Sunday at 1 p.m. New York time.</span><span><LockKeyhole size={15} />Invite-only. Always private.</span></div>}{error && <div className="form-error" role="alert">{error}</div>}<button className="button button-green button-full" disabled={busy}>{busy ? 'One moment…' : mode === 'create' ? 'Create league' : 'Join league'}<ArrowRight size={17} /></button></form></Modal>;
}

function PickModal({ dashboard, onClose, onSave }: { dashboard: Dashboard; onClose: () => void; onSave: (id: string) => Promise<void> }) {
  const [selected, setSelected] = useState<string | null>(dashboard.myPick?.teamId || null); const [search, setSearch] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const team = teamById(selected);
  const availableTeams = teams.filter(team => `${team.name} ${team.abbreviation}`.toLowerCase().includes(search.toLowerCase()));
  function gameFor(id: string) { return dashboard.games.find(game => game.homeTeamId === id || game.awayTeamId === id); }
  function unavailable(id: string) { const game = gameFor(id); return dashboard.myPick?.locked && dashboard.myPick.teamId !== id ? 'Your pick is locked' : dashboard.usedTeamIds.includes(id) && dashboard.myPick?.teamId !== id ? 'Already used' : !game ? 'No game this week' : !dashboard.demo && (new Date(game.kickoff).getTime() <= Date.now() || new Date(dashboard.revealAt).getTime() <= Date.now()) ? 'Locked' : null; }
  async function submit() { if (!selected) return; setBusy(true); setError(''); try { await onSave(selected); } catch (error) { setError(error instanceof Error ? error.message : 'Unable to save your pick.'); } finally { setBusy(false); } }
  return <Modal title="MAKE YOUR MOVE." subtitle={`Week ${dashboard.week}. One team. Choose the one you trust to win.`} onClose={onClose} wide><div className="pick-modal-notice"><LockKeyhole size={17} /><span>{dashboard.demo ? 'Preview mode: your selection is saved only in this browser session.' : 'Only you can see your pick until Sunday at 1 p.m. New York time.'}</span></div><label className="search-input picker-search"><Search size={17} /><input autoFocus value={search} onChange={event => setSearch(event.target.value)} placeholder="Find your team…" aria-label="Search teams" /><span>{32 - dashboard.usedTeamIds.length} available</span></label><div className="team-picker-grid">{availableTeams.map(team => { const reason = unavailable(team.id); const game = gameFor(team.id); const home = game?.homeTeamId === team.id; const opponent = teamById(home ? game?.awayTeamId : game?.homeTeamId); const odds = home ? game?.odds?.homeMoneyline : game?.odds?.awayMoneyline; return <button key={team.id} className={`team-option ${selected === team.id ? 'selected' : ''} ${reason ? 'unavailable' : ''}`} disabled={!!reason} onClick={() => setSelected(team.id)}><TeamLogo team={team} size={44} /><span><strong>{team.abbreviation}</strong><small>{reason || `${home ? 'vs' : '@'} ${opponent?.abbreviation}`}</small></span>{!reason && <span className="option-odds">{moneyline(odds)}</span>}{selected === team.id && <CheckCircle2 className="selected-check" size={17} />}</button>; })}</div>{availableTeams.length === 0 && <p className="empty-inline">No teams match your search.</p>}<div className="pick-confirmation">{team ? <div className="pick-choice"><TeamLogo team={team} size={43} /><span><small>YOUR WEEK {dashboard.week} PICK</small><strong>{team.name}</strong></span></div> : <span className="muted">Choose a team to continue.</span>}<button className="button button-green" disabled={!selected || !!unavailable(selected) || busy} onClick={() => void submit()}>{busy ? 'Saving…' : dashboard.demo ? 'Save preview pick' : 'Lock in your pick'}<Check size={17} /></button></div>{error && <div className="form-error" role="alert">{error}</div>}<p className="picker-footnote">Picks lock at the earlier of your game’s kickoff or Sunday 1 p.m. New York time. A loss, tie, or missed pick ends your run. Odds are informational, not a guarantee.</p></Modal>;
}

function RulesModal({ onClose }: { onClose: () => void }) {
  const rules = [
    ['01', 'ONE TEAM. EVERY WEEK.', 'Pick one NFL team you believe will win its game. This is survivor: you select a team, not individual players, and the point spread does not decide survival.'],
    ['02', 'WIN AND YOU’RE IN.', 'Your team wins, you advance. A loss, a tie, or missing your weekly pick eliminates you. The last survivor wins. If the final active group all go out together, they share the win once results settle.'],
    ['03', 'NO SECOND HELPINGS.', 'You can use each NFL team only once during the season. Plan ahead instead of spending all the favorites early.'],
    ['04', 'LOCK IT IN. KEEP IT SECRET.', 'Submit or change your pick before the earlier of your selected game’s kickoff or Sunday at 1 p.m. New York time. Once locked, your choice is final.'],
    ['05', 'SUNDAY IS THE BIG REVEAL.', 'All other members’ picks stay hidden until Sunday at 1 p.m. America/New_York, including daylight saving time. Early games can lock before the reveal.'],
    ['06', 'ODDS ARE CONTEXT.', 'Moneylines and implied probabilities help you compare favorites. They include bookmaker margin, can change, and never guarantee a result. This app accepts no wagers.'],
  ];
  return <Modal title="THE RULES OF SURVIVAL." subtitle="Easy to learn. A whole season to master." onClose={onClose} wide><div className="rules-list">{rules.map(([number, title, body]) => <div className="rule" key={number}><span>{number}</span><div><h3>{title}</h3><p>{body}</p></div></div>)}</div><div className="rules-bottom"><ShieldCheck size={18} /><p>Private by design. League members cannot access opponents’ unrevealed picks, including through the API. Delayed results stay pending. A confirmed canceled game is void: you survive, but that team stays used.</p></div></Modal>;
}

export default App;
