use mini::greet::hello;

#[test]
fn greets() {
    assert_eq!(hello("a"), "hello, a");
}
