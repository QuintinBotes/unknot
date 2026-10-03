use shop::routes::orders;

#[test]
fn lists() {
    let _ = orders::list_orders();
}
