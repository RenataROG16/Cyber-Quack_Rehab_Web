// =====================================================================
//  Señal del SENSOR ESP32 (EMG real) en la app.
//
//  TODO el procesamiento de la señal lo hace el ESP32:
//    offset fijo (3.3 V / 2) → notch 60 Hz → rectificación → envolvente (Butterworth 5 Hz)
//
//  El sensor manda paquetes {i, fs, fe, s:[...], e:[...]}, en mV a la SALIDA del circuito:
//    s = 128 muestras a 2000 Hz de la señal limpia (sin offset, con notch)
//    e = 8 valores de la ENVOLVENTE (fe = 125 por segundo)
//
//  La app NO vuelve a filtrar nada. Solo aplica la fórmula y calcula las variables:
//    1) mV en la piel = mV a la salida / ganancia total (700)
//    2) RMS por ventana de 512 muestras (sobre s)
//    2b) A la envolvente se le resta el nivel de reposo (ruido del circuito) → 0 en reposo
//    3) Amplitud máxima = máximo de la envolvente (e), ya sin reposo
//    4) MNF y MDF por ventana de 512 muestras (sobre s, sin rectificar), con ventana de Hann,
//       solo los bins 6 a 115 (23.4 a 449.2 Hz) — el método de la evidencia técnica
//  y guarda la envolvente para dibujarla.
//
//  Es independiente de la pantalla (no toca el DOM), por eso se puede probar sola.
// =====================================================================
(function (raiz) {
  const GANANCIA_TOTAL = 700;   // ganancia total del circuito (la única constante de la fórmula)
  const FS = 2000;              // muestras por segundo de s
  const FS_ENV = 125;           // valores por segundo de e
  const VENTANA_RMS = 512;

  // ---- Espectro (MNF / MDF): ventana de Hann de 512 muestras, bins 6 a 115 ----
  const N_ESPECTRO = 512;                  // = VENTANA_RMS (potencia de 2)
  const BIN_MIN = 6, BIN_MAX = 115;        // a 2000 Hz: 23.4 a 449.2 Hz (la banda del filtro pasa-bandas)
  const HANN = new Float64Array(N_ESPECTRO), COS = new Float64Array(N_ESPECTRO), SIN = new Float64Array(N_ESPECTRO);
  for (let n = 0; n < N_ESPECTRO; n++) {
    HANN[n] = 0.5 - 0.5 * Math.cos(2 * Math.PI * n / (N_ESPECTRO - 1));
    COS[n] = Math.cos(2 * Math.PI * n / N_ESPECTRO);
    SIN[n] = Math.sin(2 * Math.PI * n / N_ESPECTRO);
  }

  // MNF = Σ(f·P)/ΣP ;  MDF = frecuencia que parte la potencia a la mitad (interpolada entre bins)
  function mnfMdf(x, fs) {
    const N = N_ESPECTRO, xw = new Float64Array(N);
    for (let n = 0; n < N; n++) xw[n] = x[n] * HANN[n];
    const P = new Float64Array(BIN_MAX - BIN_MIN + 1);
    let sumP = 0, sumFP = 0;
    for (let k = BIN_MIN; k <= BIN_MAX; k++) {
      let re = 0, im = 0;
      for (let n = 0; n < N; n++) { const i = (k * n) & (N - 1); re += xw[n] * COS[i]; im -= xw[n] * SIN[i]; }
      const p = re * re + im * im;
      P[k - BIN_MIN] = p; sumP += p; sumFP += p * (k * fs / N);
    }
    if (!(sumP > 0)) return { mnf: null, mdf: null };
    const mitad = sumP / 2;
    let acumulada = 0, mdf = null;
    for (let i = 0; i < P.length; i++) {
      const siguiente = acumulada + P[i];
      if (siguiente >= mitad) {
        const fm = (BIN_MIN + i) * fs / N;
        if (i === 0) mdf = fm;
        else { const fAnt = (BIN_MIN + i - 1) * fs / N; mdf = fAnt + ((mitad - acumulada) / P[i]) * (fm - fAnt); }
        break;
      }
      acumulada = siguiente;
    }
    return { mnf: sumFP / sumP, mdf: mdf };
  }

  // ---------------------------------------------------------------------------
  //  QUITAR EL NIVEL DE REPOSO de la envolvente.
  //  Con el músculo relajado la envolvente NO es cero: es el ruido del circuito rectificado
  //  (≈ 0.07–0.12 V a la salida). Esta clase aprende ese nivel sola y lo resta,
  //  para que en reposo la señal quede en 0 y solo suba cuando hay contracción.
  //    · Mientras la señal parece reposo, aprende el nivel (despacio, ~2 s).
  //    · Si la señal baja de lo aprendido, se ajusta rápido (~0.5 s).
  //    · Durante una contracción casi no se mueve (constante de 2 min), así no "se come" la contracción.
  //  Trabaja en mV en la piel.
  // ---------------------------------------------------------------------------
  const RUIDO_MIN_MV = 0.002;     // margen mínimo (mV en la piel) para que el reposo quede en 0
  class QuitaReposo {
    constructor(fe) { this.fe = fe || FS_ENV; this.reiniciar(); }
    reiniciar() { this.piso = null; this.ruido = 0; this.n = 0; }
    // Nivel que se resta: el reposo promedio + un margen por su ruido
    get nivel() { return this.piso === null ? 0 : this.piso + 2 * this.ruido + RUIDO_MIN_MV; }
    procesar(x) {
      if (!Number.isFinite(x)) return 0;
      const fe = this.fe, aprendiendo = this.n < fe;   // el primer segundo aprende rápido
      this.n++;
      if (this.piso === null) { this.piso = x; this.ruido = Math.abs(x) * 0.1; return 0; }
      const desv = x - this.piso;
      const pareceReposo = desv <= 3 * this.ruido + RUIDO_MIN_MV;
      const alfa = (tau) => 1 - Math.exp(-1 / (tau * fe));
      if (desv < 0) {
        this.piso += desv * alfa(0.5);
        this.ruido += (-desv - this.ruido) * alfa(2);
      } else if (pareceReposo || aprendiendo) {
        const a = alfa(aprendiendo ? 0.3 : 2);
        this.piso += desv * a;
        this.ruido += (desv - this.ruido) * a;
      } else {
        this.piso += desv * alfa(120);   // contracción: casi no se mueve
      }
      return Math.max(0, x - this.nivel);
    }
  }

  class ProcesadorSensorEmg {
    constructor(opciones) {
      opciones = opciones || {};
      this.ganancia = opciones.ganancia || GANANCIA_TOTAL;
      this.segundosVentana = opciones.segundosVentana || 5;   // segundos que se ven en la gráfica
      this.reiniciar();
    }

    reiniciar() {
      this.fe = FS_ENV;
      this.reposo = new QuitaReposo(this.fe);   // la envolvente guardada ya va SIN el nivel de reposo
      this.prepararBufferEnvolvente();
      // Ventana de 512 muestras de s: RMS, MNF y MDF
      this.bufS = new Float64Array(N_ESPECTRO); this.nS = 0;
      this.rms = null; this.mnf = null; this.mdf = null;
      this.envVentana = null;     // promedio de la envolvente durante esa ventana (para saber si había contracción)
      this.ventanas = 0;          // cuántas ventanas se han cerrado (la app lo usa para saber cuándo hay datos nuevos)
      // amplitud máxima (de la envolvente) y estado de la conexión
      this.pico = 0;
      this.envActual = 0;
      this.fuenteEnv = 'sin datos';   // 'sensor' = el paquete trae la envolvente · 'sin envolvente' = no la trae
      this.ultimoId = null; this.paquetes = 0; this.paquetesPerdidos = 0;
      this.fsRecibida = FS;
    }

    prepararBufferEnvolvente() {
      this.n = Math.max(2, Math.round(this.segundosVentana * this.fe));
      this.env = new Float32Array(this.n);   // envolvente en mV en la piel (buffer circular)
      this.escritura = 0;
      this.total = 0;
    }

    // payload: { i, fs, fe, s:[...], e:[...] }  (en mV a la salida del circuito)
    procesarPaquete(payload) {
      if (!payload || !Array.isArray(payload.s)) return;
      this.paquetes++;
      if (payload.fs) this.fsRecibida = payload.fs;
      if (typeof payload.i === 'number') {
        if (this.ultimoId !== null && payload.i !== this.ultimoId + 1 && payload.i > this.ultimoId) {
          this.paquetesPerdidos += payload.i - this.ultimoId - 1;
        }
        this.ultimoId = payload.i;
      }
      const g = this.ganancia;
      const s = payload.s;

      // 1) Envolvente del ESP32 → mV en la piel, tal cual llega (sin interpolar ni recalcular)
      const e = payload.e;
      const hayEnv = Array.isArray(e) && e.length > 0 && e.every(Number.isFinite);
      this.fuenteEnv = hayEnv ? 'sensor' : 'sin envolvente';
      if (hayEnv) {
        if (payload.fe && payload.fe !== this.fe) { this.fe = payload.fe; this.reposo.fe = payload.fe; this.prepararBufferEnvolvente(); }
        for (let j = 0; j < e.length; j++) {
          const v = this.reposo.procesar(e[j] / g);   // 0 en reposo, sube con la contracción
          if (v > this.pico) this.pico = v;
          this.env[this.escritura] = v;
          this.escritura = (this.escritura + 1) % this.n;
          this.total++;
          this.envActual = v;
        }
      }
      const decim = hayEnv ? Math.max(1, Math.round(s.length / e.length)) : 16;   // muestras de s por valor de e

      // 2) Señal limpia → mV en la piel → ventanas de 512 muestras: RMS, MNF y MDF
      for (let k = 0; k < s.length; k++) {
        const x = s[k] / g;
        this.bufS[this.nS++] = Number.isFinite(x) ? x : 0;
        if (this.nS >= N_ESPECTRO) {
          let suma = 0;
          for (let n = 0; n < N_ESPECTRO; n++) suma += this.bufS[n] * this.bufS[n];
          this.rms = Math.sqrt(suma / N_ESPECTRO);
          const r = mnfMdf(this.bufS, this.fsRecibida || FS);
          this.mnf = r.mnf; this.mdf = r.mdf;
          this.envVentana = hayEnv ? this.promedioEnvolvente(Math.round(N_ESPECTRO / decim)) : null;
          this.ventanas++;
          this.nS = 0;
        }
      }
    }

    // Promedio de los últimos `cuantos` valores de la envolvente (mV en la piel)
    promedioEnvolvente(cuantos) {
      const c = Math.min(cuantos, this.total, this.n);
      if (c < 1) return null;
      let suma = 0;
      for (let k = 1; k <= c; k++) suma += this.env[(this.escritura - k + this.n) % this.n];
      return suma / c;
    }

    // Para dibujar: la envolvente de la ventana, de lo más viejo a lo más nuevo.
    // `capacidad` = cuántos puntos caben en la ventana completa (para que la gráfica no se estire al empezar).
    // Devuelve null si todavía no hay datos.
    envolvente() {
      const cuantas = Math.min(this.total, this.n);
      if (cuantas < 2) return null;
      const inicio = (this.escritura - cuantas + this.n) % this.n;
      const datos = new Float32Array(cuantas);
      for (let k = 0; k < cuantas; k++) datos[k] = this.env[(inicio + k) % this.n];
      return { datos, capacidad: this.n, segundos: this.segundosVentana };
    }
  }

  const api = { ProcesadorSensorEmg, QuitaReposo, GANANCIA_TOTAL, FS, FS_ENV, VENTANA_RMS, mnfMdf, BIN_MIN, BIN_MAX };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else raiz.SensorEmg = api;
})(typeof window !== 'undefined' ? window : globalThis);
