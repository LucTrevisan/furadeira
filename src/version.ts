/**
 * Versão do build e verificação de atualização.
 *
 * O GitHub Pages (e proxies de redes corporativas) podem entregar a página
 * antiga por um tempo. A página consulta version.json SEM cache; se o
 * commit publicado for outro, recarrega com ?v=<commit> (que fura o cache).
 * Se mesmo assim continuar antiga (proxy teimoso), só avisa — sem loop.
 */
declare const __APP_VERSION__: { commit: string; time: string };

export const APP_VERSION = __APP_VERSION__;

export function versionLabel(): string {
  const d = new Date(APP_VERSION.time);
  const when = Number.isNaN(d.getTime())
    ? ""
    : ` · ${d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })} ${d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;
  return `versão ${APP_VERSION.commit}${when}`;
}

export interface UpdateHooks {
  /** Pode recarregar agora? (não durante uma sessão VR) */
  canReload: () => boolean;
  notify: (msg: string) => void;
}

export function startUpdateCheck(hooks: UpdateHooks, everyMs = 5 * 60_000): void {
  if (import.meta.env.DEV || APP_VERSION.commit === "dev") return;
  const check = async (): Promise<void> => {
    try {
      const r = await fetch(`${import.meta.env.BASE_URL}version.json?t=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) return;
      const v = (await r.json()) as { commit?: unknown };
      if (typeof v.commit !== "string" || !/^[\w-]{1,40}$/.test(v.commit) || v.commit === APP_VERSION.commit) return;
      const url = new URL(location.href);
      if (url.searchParams.get("v") === v.commit) {
        // Já recarregamos pedindo essa versão e ainda veio a antiga: proxy/cache.
        hooks.notify(`Há uma versão mais nova (${v.commit}). Recarregue com Ctrl+F5 ou limpe o cache.`);
        return;
      }
      if (!hooks.canReload()) {
        hooks.notify(`Nova versão disponível (${v.commit}): recarregue ao sair do VR.`);
        return;
      }
      hooks.notify(`Atualizando para a versão ${v.commit}…`);
      url.searchParams.set("v", v.commit);
      window.setTimeout(() => location.replace(url.toString()), 1500);
    } catch {
      // sem rede: tenta de novo mais tarde
    }
  };
  void check();
  window.setInterval(() => void check(), everyMs);
}
