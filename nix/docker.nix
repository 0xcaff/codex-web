{
  self,
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
    packages =
      (with pkgs; [
        cacert
        coreutils
        bashInteractive
        gnugrep
        gawk
        findutils
        procps
        curl
        jq
        tree
        vim
        tmux
        ripgrep
      ])
      ++ [
        self.packages.${system}.codex
      ];
  in
  {
    packages = pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
      dockerImage = pkgs.dockerTools.buildLayeredImage {
        name = "codex-hosted";
        tag = "latest";
        contents = [
          self.packages.${system}.default
        ] ++ packages;
        fakeRootCommands = ''
          mkdir -p bin
          ln -sf ${pkgs.bashInteractive}/bin/bash bin/bash
          ln -sf ${pkgs.bashInteractive}/bin/bash bin/sh
        '';
        config = {
          Cmd = [
            "${pkgs.coreutils}/bin/env"
            "CODEX_CLI_PATH=${self.packages.${system}.codex}/bin/codex"
            "${self.packages.${system}.default}/bin/codex-hosted-server"
            "--host"
            "0.0.0.0"
            "--port"
            "8214"
          ];
          ExposedPorts = {
            "8214/tcp" = { };
          };
          Env = [
            "NODE_ENV=production"
            "HOME=/tmp"
            "PATH=${pkgs.lib.makeBinPath packages}"
            "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
          ];
        };
      };
    };
  }
)
