// =========================================================
// AUTENTICACIÓN — login único que sirve para fisio y paciente.
// Después del login, lee el rol desde la tabla `profiles` y
// manda a cada quien a su pantalla correspondiente.
// La sesión de cada rol se guarda aparte (ver supabaseClient.js).
// =========================================================

function irA(url) { window.location.href = url; }

async function iniciarSesion(email, password, rolElegido) {
  const rol = rolElegido === 'physio' ? 'physio' : 'patient';
  const cliente = clienteSupabase(rol);

  const { data, error } = await cliente.auth.signInWithPassword({ email, password });
  if (error) {
    mostrarError(error.message);
    return;
  }

  await enrutarSegunRol(cliente, data.session, rol);
}

async function registrarUsuario(email, password, fullName, rol, codigoFisio) {
  const cliente = clienteSupabase(rol);

  // 1. Crear la cuenta de autenticación (solo email/password)
  const { data, error } = await cliente.auth.signUp({ email, password });
  if (error) { mostrarError(error.message); return; }
  if (!data.session) { mostrarError('Cuenta creada. Confirma tu correo y luego inicia sesión.'); return; }

  const userId = data.user.id;

  // 2. Si es paciente, primero buscamos a qué fisio vincularlo
  let linkedPhysioId = null;
  if (rol === 'patient') {
    const { data: physio, error: physioErr } = await cliente
      .from('profiles')
      .select('id')
      .eq('role', 'physio')
      .eq('invite_code', codigoFisio)
      .single();

    if (physioErr || !physio) {
      mostrarError('Código de fisioterapeuta no válido.');
      return;
    }
    linkedPhysioId = physio.id;
  }

  // 3. Crear la fila en `profiles` con el rol y el vínculo
  const { error: profileErr } = await cliente.from('profiles').insert({
    id: userId,
    full_name: fullName,
    role: rol,
    linked_physio_id: linkedPhysioId
  });

  if (profileErr) { mostrarError(profileErr.message); return; }

  await enrutarSegunRol(cliente, data.session, rol);
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

function mostrarError(msg) {
  const el = document.getElementById('loginError');
  if (el) el.textContent = msg;
  console.error(msg);
}
