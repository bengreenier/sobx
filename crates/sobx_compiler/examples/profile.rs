//! `cargo run --release --example profile -- <file>`: time each analyzer phase.
fn main() {
    let path = std::env::args().nth(1).expect("usage: profile <file>");
    let source = std::fs::read_to_string(path).expect("readable file");
    for _ in 0..5 {
        sobx_compiler::profile_phases(&source);
    }
    let runs = 30;
    let mut total = [0.0; 4];
    for _ in 0..runs {
        let p = sobx_compiler::profile_phases(&source);
        for i in 0..4 {
            total[i] += p[i];
        }
    }
    let [parse, semantic, analyze, serialize] = total.map(|t| t / runs as f64);
    println!("parse {parse:.2}ms  semantic {semantic:.2}ms  analyze {analyze:.2}ms  serialize {serialize:.2}ms");
}
