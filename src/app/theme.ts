// Tema claro/escuro. A preferência fica no navegador, separada por usuário (chave com o id do usuário), então cada
// pessoa que entra no mesmo computador tem a sua, e nada vai para o banco. A chave "usuario" diz de quem é a
// preferência a aplicar antes da página aparecer (script no <head> do layout), para não piscar o tema errado.
// Tema escuro = sem atributo no <html>; tema claro = data-theme="light" (as cores do claro só valem com ele).
export type Theme = "dark" | "light";
export const THEME_USER_KEY = "crediai:tema:usuario";
export const themeKey = (userId: string) => `crediai:tema:${userId}`;

// Roda no <head>, antes de pintar a página: aplica o tema salvo do último usuário que usou este navegador.
export const THEME_BOOT_SCRIPT = `try{var u=localStorage.getItem("${THEME_USER_KEY}");if(u&&localStorage.getItem("crediai:tema:"+u)==="light")document.documentElement.dataset.theme="light"}catch(e){}`;
