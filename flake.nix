{
  description = "topowall - topographic contour wallpapers from real elevation data";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAll = f: nixpkgs.lib.genAttrs systems (s: f nixpkgs.legacyPackages.${s});
      runtimeLibs = pkgs: with pkgs; [ vulkan-loader libGL wayland libxkbcommon ];
    in {
      packages = forAll (pkgs: rec {
        topowall = pkgs.rustPlatform.buildRustPackage {
          pname = "topowall";
          version = "0.3.0";
          src = self;
          cargoLock.lockFile = ./Cargo.lock;
          nativeBuildInputs = [ pkgs.makeWrapper ];
          postFixup = ''
            wrapProgram $out/bin/topowall \
              --prefix LD_LIBRARY_PATH : ${pkgs.lib.makeLibraryPath (runtimeLibs pkgs)}
          '';
          meta = {
            description = "Topographic contour wallpapers from real elevation data";
            license = pkgs.lib.licenses.mit;
            mainProgram = "topowall";
          };
        };
        default = topowall;
      });

      devShells = forAll (pkgs: {
        default = pkgs.mkShell {
          packages = with pkgs; [ rustc cargo clippy rustfmt rust-analyzer ];
          LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath (runtimeLibs pkgs);
        };
      });
    };
}
