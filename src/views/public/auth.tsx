import { useC } from '../render';
import { AuthLayout } from '../layout';
import { Csrf, Field, Select, Check } from '../components';
import { countryOptions } from '../../lib/geo';
import { LANGS } from '../../lib/i18n';
import { config } from '../../lib/config';
import { FaGoogle } from 'react-icons/fa6';

function GoogleBtn({ next }: { next?: string }) {
  const c = useC();
  if (!config.googleClientId) return null;
  return <>
    <a className="btn btn-ghost btn-block google" href={`/auth/google${next ? `?next=${encodeURIComponent(next)}` : ''}`}><FaGoogle aria-hidden /> {c.t('auth.google')}</a>
    <p className="or"><span>{c.t('auth.or')}</span></p>
  </>;
}

export function SignupPage({ v = {}, error, next }: { v?: Record<string, string>; error?: string; next?: string }) {
  const c = useC();
  return (
    <AuthLayout title={c.t('auth.signup_title')}>
      <h1>{c.t('auth.signup_title')}</h1>
      <p className="muted">{c.t('auth.signup_sub')}</p>
      {error && <div className="flash flash-error" role="alert">{error}</div>}
      <GoogleBtn next={next} />
      <form method="post" action="/signup" noValidate={false}>
        <Csrf />
        {next && <input type="hidden" name="next" value={next} />}
        <div className="row-2">
          <Field label={c.t('auth.first')} name="first_name" required autoComplete="given-name" value={v.first_name} maxLength={60} />
          <Field label={c.t('auth.last')} name="last_name" required autoComplete="family-name" value={v.last_name} maxLength={60} />
        </div>
        <Field label={c.t('auth.email')} name="email" type="email" required autoComplete="email" value={v.email} />
        <div className="row-2">
          <Select label={c.t('auth.country')} name="country" value={v.country || 'NG'} options={countryOptions(c.lang).map((x) => ({ value: x.code, label: x.name }))} />
          <Field label={c.t('auth.city')} name="city" autoComplete="address-level2" value={v.city} maxLength={60} />
        </div>
        <Field label={c.t('auth.phone')} name="phone" type="tel" required autoComplete="tel" value={v.phone} placeholder="+234 803 000 0000" dir="ltr" />
        <Field label={c.t('auth.password')} name="password" type="password" required autoComplete="new-password" hint={c.t('auth.password_hint')} />
        <Field label={c.t('auth.referral')} name="ref" value={v.ref} maxLength={12} />
        <input type="hidden" name="lang" value={c.lang} />
        <Check name="feed_opt_in" label={c.t('auth.feed_opt')} checked={v.feed_opt_in !== 'off'} />
        <Check name="agree" required label={<>{c.t('auth.agree')} <a href="/legal/terms" target="_blank">{c.t('footer.terms')}</a> · <a href="/legal/privacy" target="_blank">{c.t('footer.privacy')}</a> · <a href="/legal/risk" target="_blank">{c.t('footer.risk')}</a></>} />
        <button className="btn btn-primary btn-block btn-lg" type="submit">{c.t('auth.create')}</button>
      </form>
      <p className="center">{c.t('auth.have_account')} <a href="/login">{c.t('nav.login')}</a></p>
    </AuthLayout>
  );
}

export function LoginPage({ email, error, next }: { email?: string; error?: string; next?: string }) {
  const c = useC();
  return (
    <AuthLayout title={c.t('nav.login')}>
      <h1>{c.t('auth.login_title')}</h1>
      {error && <div className="flash flash-error" role="alert">{error}</div>}
      <GoogleBtn next={next} />
      <form method="post" action="/login">
        <Csrf />
        {next && <input type="hidden" name="next" value={next} />}
        <Field label={c.t('auth.email')} name="email" type="email" required autoComplete="email" value={email} />
        <Field label={c.t('auth.password')} name="password" type="password" required autoComplete="current-password" />
        <div className="row-between"><Check name="remember" label={c.t('auth.remember')} /><a href="/forgot-password" className="small">{c.t('auth.forgot')}</a></div>
        <button className="btn btn-primary btn-block btn-lg" type="submit">{c.t('auth.login')}</button>
      </form>
      <p className="center">{c.t('auth.no_account')} <a href="/signup">{c.t('nav.signup')}</a></p>
    </AuthLayout>
  );
}

export function TwoFactorPage({ error }: { error?: string }) {
  const c = useC();
  return (
    <AuthLayout title={c.t('auth.twofa_title')}>
      <h1>{c.t('auth.twofa_title')}</h1>
      <p className="muted">{c.t('auth.twofa_sub')}</p>
      {error && <div className="flash flash-error" role="alert">{error}</div>}
      <form method="post" action="/login/2fa">
        <Csrf />
        <Field label={c.t('auth.code')} name="code" required inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} dir="ltr" />
        <button className="btn btn-primary btn-block" type="submit">{c.t('auth.verify')}</button>
      </form>
      <form method="post" action="/logout" className="center"><Csrf /><button className="linklike" type="submit">{c.t('nav.logout')}</button></form>
    </AuthLayout>
  );
}

export function VerifyEmailPage({ email, demoLink }: { email: string; demoLink?: string }) {
  const c = useC();
  return (
    <AuthLayout title={c.t('auth.verify_email_title')}>
      <h1>{c.t('auth.verify_email_title')}</h1>
      <p>{c.t('auth.verify_email_sent', { email })}</p>
      {demoLink && <p className="demo-banner"><a href={demoLink}>{c.t('auth.demo_link')}</a></p>}
      <form method="post" action="/verify-email/resend"><Csrf /><button className="btn btn-ghost" type="submit">{c.t('auth.resend')}</button></form>
      <p><a href="/app">{c.t('auth.skip')}</a></p>
    </AuthLayout>
  );
}

export function VerifyPhonePage({ phone, sent, demoCode, error }: { phone: string; sent: boolean; demoCode?: string; error?: string }) {
  const c = useC();
  return (
    <AuthLayout title={c.t('auth.phone_title')}>
      <h1>{c.t('auth.phone_title')}</h1>
      {error && <div className="flash flash-error" role="alert">{error}</div>}
      {!sent ? <>
        <p className="muted">{c.t('auth.phone_sub')}</p>
        <form method="post" action="/verify-phone/send">
          <Csrf />
          <Field label={c.t('auth.phone')} name="phone" type="tel" required value={phone} dir="ltr" autoComplete="tel" />
          <button className="btn btn-primary btn-block" type="submit">{c.t('auth.send_code')}</button>
        </form>
      </> : <>
        <p>{c.t('auth.phone_sent', { phone })}</p>
        {demoCode && <p className="demo-banner">{c.t('auth.demo_code', { code: demoCode })}</p>}
        <form method="post" action="/verify-phone">
          <Csrf />
          <Field label={c.t('auth.code')} name="code" required inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} dir="ltr" />
          <button className="btn btn-primary btn-block" type="submit">{c.t('auth.verify')}</button>
        </form>
        <form method="post" action="/verify-phone/send"><Csrf /><input type="hidden" name="phone" value={phone} /><button className="linklike" type="submit">{c.t('auth.resend')}</button></form>
      </>}
      <p className="center"><a href="/welcome">{c.t('auth.skip')}</a></p>
    </AuthLayout>
  );
}

export function ForgotPage({ sent }: { sent?: boolean }) {
  const c = useC();
  return (
    <AuthLayout title={c.t('auth.reset_title')}>
      <h1>{c.t('auth.reset_title')}</h1>
      {sent ? <p>{c.t('auth.reset_sent')}</p> : <>
        <p className="muted">{c.t('auth.reset_sub')}</p>
        <form method="post" action="/forgot-password"><Csrf />
          <Field label={c.t('auth.email')} name="email" type="email" required autoComplete="email" />
          <button className="btn btn-primary btn-block" type="submit">{c.t('auth.reset_send')}</button>
        </form>
      </>}
      <p className="center"><a href="/login">{c.t('nav.login')}</a></p>
    </AuthLayout>
  );
}

export function ResetPage({ token, error }: { token: string; error?: string }) {
  const c = useC();
  return (
    <AuthLayout title={c.t('auth.reset_title')}>
      <h1>{c.t('auth.reset_title')}</h1>
      {error && <div className="flash flash-error" role="alert">{error}</div>}
      <form method="post" action={`/reset-password/${token}`}><Csrf />
        <Field label={c.t('auth.new_password')} name="password" type="password" required autoComplete="new-password" hint={c.t('auth.password_hint')} />
        <button className="btn btn-primary btn-block" type="submit">{c.t('common.save')}</button>
      </form>
    </AuthLayout>
  );
}

export function WelcomeTour() {
  const c = useC();
  return (
    <AuthLayout title={c.t('tour.1_t')}>
      <div className="tour" data-tour>
        {[1, 2, 3].map((i) => (
          <section key={i} className="tour-step" data-step={i} hidden={i !== 1}>
            <p className="eyebrow dark">{i} / 3</p>
            <div className={`tour-art art-${i}`} aria-hidden="true" />
            <h1>{c.t(`tour.${i}_t`)}</h1>
            <p className="big">{c.t(`tour.${i}_d`)}</p>
            {i < 3 ? <button type="button" className="btn btn-primary btn-block" data-tour-next>{c.t('tour.next')}</button>
              : <form method="post" action="/welcome"><Csrf /><button className="btn btn-primary btn-block" type="submit">{c.t('tour.done')}</button></form>}
          </section>
        ))}
        <form method="post" action="/welcome" className="center"><Csrf /><button className="linklike" type="submit">{c.t('tour.skip')}</button></form>
      </div>
    </AuthLayout>
  );
}

export const _langs = LANGS;
