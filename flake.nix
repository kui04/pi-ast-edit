{
  description = "pi-ast-edit: ast-grep powered code editing for pi";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    rust-overlay.url = "github:oxalica/rust-overlay";
    flake-utils.url = "github:numtide/flake-utils";
    git-hooks.url = "github:cachix/git-hooks.nix";
  };

  outputs =
    {
      self,
      nixpkgs,
      rust-overlay,
      flake-utils,
      git-hooks,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs {
          inherit system;
          overlays = [ rust-overlay.overlays.default ];
        };
        rustToolchain = pkgs.rust-bin.stable.latest.default.override {
          extensions = [ "rust-src" ];
        };
        src = pkgs.lib.cleanSourceWith {
          src = ./.;
          filter =
            path: type:
            type != "directory"
            || !(builtins.elem (baseNameOf path) [
              "target"
              "node_modules"
              "result"
            ]);
        };
        # Dynamic glibc build (dev / local use).
        piAstEdit = pkgs.rustPlatform.buildRustPackage {
          pname = "pi-ast-edit";
          version = "0.1.0";
          inherit src;
          cargoLock.lockFile = ./Cargo.lock;
        };
        # Fully static musl build (release binaries for Linux).
        piAstEditStatic = pkgs.pkgsStatic.rustPlatform.buildRustPackage {
          pname = "pi-ast-edit";
          version = "0.1.0";
          inherit src;
          cargoLock.lockFile = ./Cargo.lock;
        };
        # Pre-commit hooks via nix. Installed into the dev shell (shellHook);
        # can also run all of them manually with `nix fmt`.
        # Not wired into `checks`: clippy needs the cargo dependency cache, which
        # `nix flake check`'s sandbox (no network) cannot provide. CI covers the
        # same checks in .github/workflows/checks.yml anyway.
        pre-commit-check = git-hooks.lib.${system}.run {
          src = ./.;
          hooks = {
            clippy = {
              # Use the dev shell toolchain (1.98.1) so incremental cargo cache
              # is compatible; the default nixpkgs rustc (1.97.x) would
              # recompile everything and still hit E0514 on target/.
              enable = true;
              packageOverrides = {
                cargo = rustToolchain;
                clippy = rustToolchain;
              };
              settings = {
                # Match CI: cargo clippy --all-targets -- -D warnings
                denyWarnings = true;
                extraArgs = "--all-targets";
              };
            };
            rustfmt = {
              enable = true;
              # Check-only, matching CI's `cargo fmt --check`.
              settings.check = true;
            };
            biome = {
              enable = true;
              settings = {
                # Check-only (no --write), matching CI's `biome ci`.
                write = false;
                flags = "--error-on-warnings";
              };
            };
            actionlint.enable = true;
          };
        };
      in
      {
        packages.default = piAstEdit;
        packages.pi-ast-edit = piAstEdit;
        packages.pi-ast-edit-static = piAstEditStatic;

        # Run every hook once: nix fmt
        formatter = pkgs.writeShellScriptBin "pre-commit-run" ''
          ${pkgs.lib.getExe pre-commit-check.package} run --all-files --config ${pre-commit-check.configFile}
        '';

        devShells.default = pkgs.mkShell {
          inherit (pre-commit-check) shellHook;
          packages = [
            rustToolchain
            pkgs.nodejs
            pkgs.gcc # tree-sitter grammars are compiled with cc
          ] ++ pre-commit-check.enabledPackages;
        };
      }
    );
}
