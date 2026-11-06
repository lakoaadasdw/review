package demo;

/** 故意留一个项目内真断掉的调用：Helper 存在但没有 missingMethod */
public class BrokenService {
    private final Helper helper;

    public BrokenService(Helper helper) {
        this.helper = helper;
    }

    public String run() {
        String v = helper.exists();
        return helper.missingMethod(v);
    }
}
