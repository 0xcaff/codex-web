{
  flake-utils,
  nixpkgs,
  ...
}:
let
  systems = [
    "aarch64-darwin"
    "x86_64-darwin"
    "aarch64-linux"
    "x86_64-linux"
  ];
in
flake-utils.lib.eachSystem systems (
  system:
  let
    pkgs = import nixpkgs { inherit system; };
    version = "0.125.0-alpha.3";
    codexSrc = pkgs.fetchFromGitHub {
      owner = "openai";
      repo = "codex";
      rev = "rust-v${version}";
      hash = "sha256-vVkwAD2vbRykfIlfxc4CyzIf/8UF94V5fKhJbAE9mog=";
    };
    rustyV8Version = "146.4.0";
    rustyV8ArchiveInfo = {
      aarch64-darwin = {
        file = "librusty_v8_release_aarch64-apple-darwin.a.gz";
        hash = "sha256-v+LJvjKlbChUbw+WWCXuaPv2BkBfMQzE4XtEilaM+Yo=";
      };
      x86_64-darwin = {
        file = "librusty_v8_release_x86_64-apple-darwin.a.gz";
        hash = "sha256-YwzSQPG77NsHFBfcGDh6uBz2fFScHFFaC0/Pnrpke7c=";
      };
      aarch64-linux = {
        file = "librusty_v8_release_aarch64-unknown-linux-gnu.a.gz";
        hash = "sha256-2/FlsHyBvbBUvARrQ9I+afz3vMGkwbW0d2mDpxBi7Ng=";
      };
      x86_64-linux = {
        file = "librusty_v8_release_x86_64-unknown-linux-gnu.a.gz";
        hash = "sha256-5ktNmeSuKTouhGJEqJuAF4uhA4LBP7WRwfppaPUpEVM=";
      };
    };
    rustyV8Archive = pkgs.fetchurl {
      url = "https://github.com/denoland/rusty_v8/releases/download/v${rustyV8Version}/${rustyV8ArchiveInfo.${system}.file}";
      hash = rustyV8ArchiveInfo.${system}.hash;
    };
  in
  {
    packages.codex = pkgs.rustPlatform.buildRustPackage {
      env.PKG_CONFIG_PATH = pkgs.lib.makeSearchPathOutput "dev" "lib/pkgconfig" (
        [ pkgs.openssl ] ++ pkgs.lib.optionals pkgs.stdenv.isLinux [ pkgs.libcap ]
      );
      env.RUSTY_V8_ARCHIVE = rustyV8Archive;

      pname = "codex";
      inherit version;
      src = codexSrc + "/codex-rs";

      cargoLock = {
        lockFile = codexSrc + "/codex-rs/Cargo.lock";
        outputHashes = {
          "crossterm-0.28.1" = "sha256-6qCtfSMuXACKFb9ATID39XyFDIEMFDmbx6SSmNe+728=";
          "libwebrtc-0.3.26" = "sha256-0HPuwaGcqpuG+Pp6z79bCuDu/DyE858VZSYr3DKZD9o=";
          "livekit-protocol-0.7.1" = "sha256-0HPuwaGcqpuG+Pp6z79bCuDu/DyE858VZSYr3DKZD9o=";
          "livekit-runtime-0.4.0" = "sha256-0HPuwaGcqpuG+Pp6z79bCuDu/DyE858VZSYr3DKZD9o=";
          "nucleo-0.5.0" = "sha256-Hm4SxtTSBrcWpXrtSqeO0TACbUxq3gizg1zD/6Yw/sI=";
          "nucleo-matcher-0.3.1" = "sha256-Hm4SxtTSBrcWpXrtSqeO0TACbUxq3gizg1zD/6Yw/sI=";
          "ratatui-0.29.0" = "sha256-HBvT5c8GsiCxMffNjJGLmHnvG77A6cqEL+1ARurBXho=";
          "runfiles-0.1.0" = "sha256-uJpVLcQh8wWZA3GPv9D8Nt43EOirajfDJ7eq/FB+tek=";
          "tokio-tungstenite-0.28.0" = "sha256-hJAkvWxDjB9A9GqansahWhTmj/ekcelslLUTtwqI7lw=";
          "tungstenite-0.27.0" = "sha256-AN5wql2X2yJnQ7lnDxpljNw0Jua40GtmT+w3wjER010=";
          "webrtc-sys-0.3.24" = "sha256-0HPuwaGcqpuG+Pp6z79bCuDu/DyE858VZSYr3DKZD9o=";
          "webrtc-sys-build-0.3.13" = "sha256-0HPuwaGcqpuG+Pp6z79bCuDu/DyE858VZSYr3DKZD9o=";
        };
      };

      doCheck = false;

      postPatch = ''
        sed -i 's/^version = "0\.0\.0"$/version = "${version}"/' Cargo.toml
      '';

      nativeBuildInputs = [
        pkgs.cmake
        pkgs.llvmPackages.clang
        pkgs.llvmPackages.libclang.lib
        pkgs.openssl
        pkgs.pkg-config
      ]
      ++ pkgs.lib.optionals pkgs.stdenv.isLinux [ pkgs.libcap ];

      meta = {
        description = "OpenAI Codex command-line interface";
        homepage = "https://github.com/openai/codex";
        license = pkgs.lib.licenses.asl20;
        mainProgram = "codex";
      };
    };
  }
)
