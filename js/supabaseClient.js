// =========================================================
// Conexión a Supabase.
//
// Cada ROL guarda su sesión en un lugar distinto del navegador.
// Así puedes tener al fisio y al paciente abiertos a la vez en el
// MISMO navegador (para probar tú solo, o en una demostración con una
// sola computadora) sin que uno le quite la sesión al otro.
// =========================================================

// Credenciales de tu proyecto (Project Settings > API en Supabase).
// La "anon key" es pública por diseño: la protegen las reglas de seguridad de la base.
const SUPABASE_URL = 'https://paahoyfrygrakninebzz.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBhYWhveWZyeWdyYWtuaW5lYnp6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA4ODcxMTQsImV4cCI6MjEwNjQ2MzExNH0.NB4GMHdIHwob89sWP_AvEOd0C_AwIKz8h9owgfKr2Jg';

const CLAVE_SESION = { physio: 'cqr-sesion-fisio', patient: 'cqr-sesion-paciente' };
const _clientesPorRol = {};

// `supabase` (global) viene del script CDN cargado en el <head> de cada página
function clienteSupabase(rol){
  if (!_clientesPorRol[rol]){
    _clientesPorRol[rol] = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { storageKey: CLAVE_SESION[rol] },
      realtime: {
        // Los "latidos" de la conexión en tiempo real van en un Web Worker: así el navegador no los
        // frena cuando la pestaña no está a la vista (si se frenan, Supabase corta la conexión).
        worker: true,
        // Si aun así se cae la conexión, se vuelve a conectar sola.
        heartbeatCallback: (estado) => {
          if (estado === 'disconnected') _clientesPorRol[rol]?.realtime?.connect?.();
        },
      },
    });
  }
  return _clientesPorRol[rol];
}

// Cada página usa el cliente de su rol (index.html elige el suyo al iniciar sesión)
const rolDePagina = /\/physio\//.test(window.location.pathname) ? 'physio' : 'patient';
// En reset.html no se crea: esa página usa su propio cliente para leer el enlace del correo
const supabaseClient = /reset\.html$/.test(window.location.pathname) ? null : clienteSupabase(rolDePagina);
