// @state Main
package mini;

import mini.greet.Greeter;

public class Main {
    public static void main(String[] args) {
        System.out.println(new Greeter().hello("world"));
    }
}
