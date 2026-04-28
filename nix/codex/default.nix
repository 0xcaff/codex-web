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
      url = "https://github.com/denoland/rusty_v8/releases/download/v${rustyV8Version}/${
        rustyV8ArchiveInfo.${system}.file
      }";
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
      cargoHash = "sha256-fDVlj7zAZnwP9YBaYaSQZXYYWrBm5IEyLT9zoorvzFg=";
      cargoBuildFlags = [
        "-p"
        "codex-cli"
      ];

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
