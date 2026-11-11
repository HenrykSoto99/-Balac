# Instalar Balac en tu laptop

Balac es una adaptación del asistente de escritorio de este repositorio. La aplicación se compila con **Tauri 2**, **Rust** y un sidecar **Node.js**.

## Requisitos

- Node.js 22 o superior y npm.
- Rust estable y Cargo.
- Los prerrequisitos de Tauri 2 para tu sistema operativo: <https://v2.tauri.app/start/prerequisites/>
- En macOS: Xcode Command Line Tools.
- En Linux: las bibliotecas de desarrollo indicadas por Tauri y `libsecret-tools` si quieres guardar la clave de voz en el llavero.

## Descargar y preparar

```bash
git clone <URL-DE-TU-COPIA-DE-BALAC> Balac
cd Balac/showcase/tauri
(cd sidecar && npm ci && npm test)
```

Si aún no tienes una copia propia, puedes partir del repositorio original y luego conservar los cambios de este proyecto:

```bash
git clone https://github.com/KenKaiii/Roamies Balac
cd Balac
```

## Compilar en modo desarrollo

```bash
cd showcase/tauri
./build.sh dev
```

Para generar el instalador de tu sistema operativo:

```bash
./build.sh
```

El resultado se genera en `showcase/tauri/src-tauri/target/release/bundle/`. En Linux normalmente encontrarás un `.AppImage`, `.deb` o `.rpm`; en Windows, un instalador `.exe`; y en macOS, un `.dmg`.

## Instalar

- **Linux:** instala el `.deb` con `sudo apt install ./Balac_*.deb`, o haz ejecutable el `.AppImage` con `chmod +x Balac*.AppImage` y ábrelo.
- **Windows:** ejecuta el instalador `.exe` generado.
- **macOS:** abre el `.dmg` y arrastra Balac a Aplicaciones.

Después abre Balac, completa el asistente inicial y configura el proveedor de IA. La aplicación conserva los permisos de micrófono, captura de pantalla y accesibilidad del proyecto original; actívalos únicamente si deseas esas funciones.

## Notas del proyecto

- El nombre visible y la identidad nativa son **Balac** (`com.balac.desktop`).
- La variante que antes se mostraba como **JARVIS** ahora se muestra como **BALAC**.
- Los nombres internos `Roamie`, `jarvis` y `roamies-*` se conservan para evitar romper compatibilidad con el motor y los helpers multiplataforma.
- El proyecto conserva la licencia AGPL-3.0 del repositorio original. Revisa `LICENSE`, `PRIVACY.md` y `THIRD_PARTY_NOTICES.md` antes de redistribuirlo.
- Esta copia no publica automáticamente instaladores ni reemplaza el repositorio original. Para distribuir Balac, crea un repositorio propio y configura tus releases y endpoints de actualización.
