// =========================================================
// AUTENTICACIÓN — login único que sirve para fisio y paciente.
// Después del login, lee el rol desde la tabla `profiles` y
// manda a cada quien a su pantalla correspondiente.
// La sesión de cada rol se guarda aparte (ver supabaseClient.js).
// =========================================================

function irA(url) { window.location.href = url; }

async function iniciarSesion(email, password, rolElegido, codigoNuevo) {
  const rol = rolElegido === 'physio' ? 'physio' : 'patient';
  const cliente = clienteSupabase(rol);

  const { data, error } = await cliente.auth.signInWithPassword({ email, password });
  if (error) {
    mostrarError(traducirError(error.message));
    return;
  }

  // Primera vez que entra después de confirmar su correo: creamos su perfil
  const listo = await asegurarPerfil(cliente, data.user, codigoNuevo);
  if (!listo) return;

  await enrutarSegunRol(cliente, data.session, rol);
}

async function registrarUsuario(email, password, fullName, rol, codigoFisio) {
  const cliente = clienteSupabase(rol);

  // Página a la que regresa el botón del correo de bienvenida
  const paginaInicio = new URL('index.html', window.location.href);
  paginaInicio.search = ''; paginaInicio.hash = '';

  // 1. Crear la cuenta. El nombre, rol y código se guardan en la cuenta
  //    para crear el perfil la primera vez que inicie sesión.
  const { data, error } = await cliente.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: paginaInicio.href,
      data: { full_name: fullName, role: rol, codigo_fisio: rol === 'patient' ? (codigoFisio || '').trim() : null }
    }
  });
  if (error) { mostrarError(traducirError(error.message)); return; }

  // 2. Si Supabase pide confirmar el correo, se manda el correo de bienvenida
  if (!data.session) {
    mostrarMensajeOk('¡Tu cuenta fue creada! 🦆<br>Te enviamos un <b>correo de bienvenida</b>. Ábrelo y toca el botón <b>“Activar mi cuenta”</b>.<br>Después regresa aquí e inicia sesión. Si no lo ves, revisa la carpeta de <b>Spam</b>.');
    if (typeof cambiarAModoLogin === 'function') cambiarAModoLogin();
    return;
  }

  // 3. Si no pide confirmación, creamos el perfil de una vez
  const listo = await asegurarPerfil(cliente, data.user, codigoFisio);
  if (!listo) return;
  await enrutarSegunRol(cliente, data.session, rol);
}

// Crea la fila en `profiles` si todavía no existe.
// Devuelve true si el perfil ya existe o se creó bien.
async function asegurarPerfil(cliente, user, codigoNuevo) {
  const { data: existente } = await cliente
    .from('profiles').select('id').eq('id', user.id).maybeSingle();
  if (existente) return true;

  const meta = user.user_metadata || {};
  const rol = meta.role === 'physio' ? 'physio' : 'patient';
  let linkedPhysioId = null;

  if (rol === 'patient') {
    const codigo = (codigoNuevo || meta.codigo_fisio || '').trim();
    const { data: physio } = codigo ? await cliente
      .from('profiles').select('id')
      .eq('role', 'physio').eq('invite_code', codigo)
      .maybeSingle() : { data: null };

    if (!physio) {
      mostrarError('El código de tu fisioterapeuta no es válido. Escríbelo abajo y toca “Continuar” otra vez.');
      if (typeof pedirCodigoFisio === 'function') pedirCodigoFisio();
      return false;
    }
    linkedPhysioId = physio.id;
  }

  const { error } = await cliente.from('profiles').insert({
    id: user.id,
    full_name: meta.full_name || '',
    role: rol,
    linked_physio_id: linkedPhysioId
  });
  if (error) { mostrarError(traducirError(error.message)); return false; }
  return true;
}

async function enrutarSegunRol(cliente, sesion, rolElegido) {
  const { data: profile, error } = await cliente
    .from('profiles')
    .select('role')
    .eq('id', sesion.user.id)
    .single();

  if (error || !profile) {
    mostrarError('No se encontró el perfil del usuario.');
    return;
  }

  // Si eligió el rol equivocado en la pantalla, su sesión se guarda donde le corresponde
  if (profile.role !== rolElegido) {
    const correcto = clienteSupabase(profile.role);
    await correcto.auth.setSession({ access_token: sesion.access_token, refresh_token: sesion.refresh_token });
    await cliente.auth.signOut({ scope: 'local' });
  }

  irA(profile.role === 'physio' ? 'physio/dashboard.html' : 'patient/sesion.html');
}

// ---------------------------------------------------------
// "¿Olvidaste tu contraseña?": Supabase manda un correo con un
// enlace que abre reset.html, donde se escribe la contraseña nueva.
// ---------------------------------------------------------
async function enviarEnlaceRecuperacion(email, rol) {
  const cliente = clienteSupabase(rol === 'physio' ? 'physio' : 'patient');
  const paginaReset = new URL('reset.html', window.location.href);
  paginaReset.search = ''; paginaReset.hash = '';

  const { error } = await cliente.auth.resetPasswordForEmail(email, {
    redirectTo: paginaReset.href
  });
  if (error) return traducirError(error.message);
  return null;
}

// Mensajes de Supabase en español y fáciles de entender
function traducirError(msg) {
  const m = (msg || '').toLowerCase();
  if (m.includes('invalid login credentials')) return 'El correo o la contraseña no son correctos.';
  if (m.includes('user already registered') || m.includes('already been registered')) return 'Ya existe una cuenta con ese correo. Inicia sesión o usa “¿Olvidaste tu contraseña?”.';
  if (m.includes('email not confirmed')) return 'Falta activar tu cuenta. Abre el correo de bienvenida que te enviamos y toca “Activar mi cuenta”. Revisa también la carpeta de Spam.';
  if (m.includes('rate limit') || m.includes('only request this after')) return 'Ya enviamos un correo hace poco. Espera unos minutos e inténtalo de nuevo.';
  if (m.includes('unable to validate email') || m.includes('invalid email')) return 'Ese correo no parece válido. Revísalo.';
  if (m.includes('password should be at least')) return 'La contraseña debe tener al menos 6 caracteres.';
  if (m.includes('same password') || m.includes('different from the old')) return 'La contraseña nueva debe ser diferente a la anterior.';
  if (m.includes('failed to fetch') || m.includes('network')) return 'No hay conexión a internet. Revisa tu conexión.';
  return msg;
}

function mostrarError(msg) {
  const el = document.getElementById('loginError');
  if (el) { el.classList.remove('login-ok'); el.textContent = msg; }
  console.error(msg);
}

// Mensaje verde (para avisos buenos, como "cuenta creada")
function mostrarMensajeOk(html) {
  const el = document.getElementById('loginError');
  if (el) { el.classList.add('login-ok'); el.innerHTML = html; }
}
